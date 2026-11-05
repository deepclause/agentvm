# JIT plan: region-based RISC-V → WebAssembly translation for AgentVM

Status: proposal. Written from fresh measurements of the shipped image (Node 22.23,
i7-7700HQ) and from reading the TinyEMU source and the patches in `image/patches/`.
Previous design notes were deliberately not used as input.

> Implementation status and deviations are tracked in
> [docs/jit-implementation.md](./jit-implementation.md). Phases 0–2 are
> implemented; chaining, the async compiler worker and the persistent cache
> are still open.

---

## 0. Summary

TinyEMU spends about 90% of host time in one wasm function: the interpreter loop
(`riscv_cpu_interp_x64`). It runs at about 100–130 guest MIPS, which is roughly 27
host cycles per guest instruction. The plan below replaces interpretation of hot
guest code with **region translation to wasm**. Its main parts:

* **Translation unit:** regions confined to one guest page. A region is a CFG with
  several basic blocks, branches inside it, and loops. Regions are keyed by
  *physical* page and are position independent, so one translation serves every
  process and every virtual mapping of that page (musl, libpython, node, kernel).
* **Hot-path dispatch:** regions chain to each other with **wasm tail calls**
  (`return_call_indirect` through the emulator's exported function table). Hot
  code does not return to the C loop until the cycle budget runs out or an
  exception occurs.
* **Async compile:** a **separate compiler worker** builds and compiles the
  modules. The emulator thread only sends page bytes and installs finished
  `WebAssembly.Module`s with `receiveMessageOnPort`. It never blocks on V8
  compilation.
* **Batching:** many regions go into one module, which brings per-region
  overhead from 50–180 µs down to 3–6 µs.
* **Invalidation:** invalidation is handled entirely in C. Each watched physical
  page has a generation word that the region checks once at entry. Every path
  that writes RAM bumps the generation: guest stores, virtio DMA, and the PV
  memcpy/memset hypercall.
* **Generic single-step fallback:** a single-step instantiation of the existing
  interpreter lets any instruction (CSR, FP, AMO, …) run inside a region through
  a helper call. The same function is also the **correctness oracle** for
  lockstep testing.
* **Persistent cache:** a content-hash-keyed translation cache, plus a prebuilt
  cache for the kernel and common binaries shipped with the image. This removes
  translation warm-up from the cold-start path.

Expected results (estimates, to be confirmed at the gates in §7):

* Translated code: 4–6x per instruction.
* End to end, CPU-bound work (Python/JS loops): 3–5x.
* End to end, startup-heavy work (`node -e 0`, `npm`, Python imports): 1.5–2x
  cold, and 2.5–4x with a prebuilt or persistent cache.

---

## 1. Measurements that drive the design

All guest instruction counts come from `rdinstret`, read from a mmap'd stub
called via ctypes. Wall times are guest `/proc/uptime` deltas.

| Workload | Guest insns | Time | MIPS |
|---|---|---|---|
| Python `while i<1e6: i+=1` | 1151M | 9.2 s | 125 |
| Python heavy imports (asyncio, http.client, …) | 452M | 4.5 s | 100 |
| `node -e 0` (warm) | ~175M | 1.4 s | 125 |
| `npm --version` | 520–600M | 5.2–6.2 s | 85–100 |
| Python `os.stat` loop | ~11k / call | 140 µs / call | 85 |

**Host profile.** 89–91% of time is in the interpreter function. 3–5% is in TLB
miss handling (`get_phys_addr`, `target_read_slow`, `target_write_slow`). Less
than 1% is in all JS/WASI glue combined.

**Hot-code footprint.** These numbers come from the existing `jit_compile`
callback, repurposed as a sampling block-entry counter (one sample per 50
slow-path block entries, in `/tmp/avm-bench/srci`):

| Workload | Distinct hot blocks | Blocks covering 50 / 80 / 90 / 95 / 99 % of executed insns | Avg block length |
|---|---|---|---|
| Python loop | ~3.3k | 7 / 20 / 32 / 128 / 951 | 6.6 |
| Python imports | ~6.6k | 50 / 461 / 1033 / 1748 / 3624 | 6.1 |
| `node -e 0` | ~4.3k | 35 / 214 / 483 / 877 / 2212 | 7.3 |
| `npm --version` | ~15.7k | 206 / 1176 / 2515 / 4267 / 9130 | 8.1 |

Implications:

* A few thousand blocks cover 90–99%. Translation volume is manageable, but only
  with batching and a persistent cache. 10k blocks at 5 µs each is 50 ms of
  compiler-worker time.
* Basic blocks are short: 6–8 instructions, and 60–76% end in a conditional
  branch. Per-block translation would spend most of its time in dispatch, so the
  unit must be a region that contains both successors of a branch.

**Block terminators** (by block entries): conditional branch 60–76%, `call`
5–9%, `ret` 5–12%, indirect call/jump 4–14%, `jal` 2–8%, system 0–8%.
Indirect control flow is 10–25%, so indirect exits need a fast inline lookup.

**Instruction mix** (biased sample; only cross-page block entries are counted):

* ALU ~40%, loads 20–26%, stores 19–25%, control 12–16%.
* AMO, system, mul/div and FP are each ≤1%.
* Compressed instructions are 47–66% of the mix.

So **memory operations are about 45%** of executed instructions, and the inline
TLB path decides how fast generated code is. The rare instruction classes can go
through a generic helper without hurting performance.

**Kernel share** (`time` user/sys): about 15–20% for startup workloads, about 50%
for process spawn loops, about 1% for CPU loops. Kernel code must be translated
too, and it is a perfect candidate for a prebuilt cache: the same bytes at the
same physical addresses on every boot, because of the Wizer snapshot.

**V8 facts** (verified on Node 22.23):

* **Tail calls.** `return_call_indirect` works without flags. It costs 2.5 ns per
  call within one instance, and 3.3 ns between two instances through a shared
  imported table. 1e8 chained calls do not grow the stack.
* **Module overhead.** A 1-region module costs 45–180 µs to compile and
  instantiate. Batching brings it down: 100 regions per module ≈ 6 µs per region,
  1000 per module ≈ 3.4 µs.
* **Cross-worker delivery.** A `WebAssembly.Module` compiled in another worker
  can be received synchronously in a busy thread with
  `worker_threads.receiveMessageOnPort()`.
* **Liftoff vs. TurboFan.** `--liftoff-only` halves interpreter speed, and
  `--no-liftoff` gains nothing. Dynamic tiering already reaches TurboFan for
  long-running code.

---

## 2. Why the current JIT has no effect

`AGENTVM_JIT=1` installs about 190 traces during boot and **zero** during the
Python and Node workloads. Timings are unchanged. Reasons:

1. **The hook is unreachable for in-page control flow.**
   * `tinyemu-fast-branch.patch` adds `FAST_JUMP_INSN`, which jumps straight to
     the fast fetch path whenever the target is in the same page.
   * `jit_try_block` only runs in the `code_ptr >= code_end` slow path, so it
     only sees cross-page transfers.
   * Self-loops are almost always in-page, so the loops-only JIT never sees them.
2. **Only self-loops qualify.** Real hot code (CPython's eval loop, V8 builtins,
   kernel paths) has calls, indirect jumps and multi-block loops.
3. **The supported subset is too small.**
   * No mul/div, AMO, LR/SC, FP, CSR or fences: any such instruction rejects the
     whole trace.
   * The `pc | 1<<63` bail encoding collides with kernel addresses, which are
     sign-extended. This is why `JIT_PC_MAX` has to exclude the kernel.
4. **Compilation is synchronous and one module per block**, on the emulator
   thread, at 50–180 µs each.
5. **No self-modifying-code story.** Translations are keyed by virtual PC only.
   This is unsafe across processes, unsafe after page reuse, and unsafe for V8's
   generated code. Today it works only because almost nothing gets translated.

Parts worth keeping:

* the LEB/section emitters and the per-instruction emitters for the integer ALU
  ops (`src/jit.js`);
* the compressed-instruction expander (`src/riscv-c.js`);
* the inline TLB probe idea (`tinyemu-jit-tlb.patch`);
* the C-side exports for state pointers (`tinyemu-jit-exports.patch`);
* the test scaffolding in `test/jit-*.test.js`.

---

## 3. Architecture

```
 emulator worker (wasm TinyEMU + thin JS)                compiler worker (JS)
 ┌───────────────────────────────────────────────┐       ┌──────────────────────────────┐
 │ riscv_cpu_interp                              │       │ decode page bytes            │
 │   at every taken branch / block boundary:     │       │ (RVC expand, classify)       │
 │     probe jump cache (vPC,priv,gen) ──hit──► call_indirect region(s, pc)            │
 │        │miss: count; hot? → physmap lookup    │       │ build region CFGs per entry  │
 │        │      → request page ─────────────────┼─msg──►│ IR → wasm (one module/batch) │
 │                                               │       │ WebAssembly.compile (async)  │
 │ jit_poll() import every main-loop iteration ◄─┼─msg───┤ post Module + region table   │
 │   receiveMessageOnPort → Instance → table.set │       └──────────────────────────────┘
 │   → write physmap entries, set page watch     │
 │                                               │
 │ region code (wasm, many modules)              │
 │   regs in locals; inline TLB; helpers;        │
 │   exits: same-page → exit slot → return_call_indirect
 │          other    → rt_dispatch (inline jump-cache probe) → return_call_indirect
 │          budget/exception/unsupported → return to C
 │                                               │
 │ RAM writers: target_write_slow, virtio DMA,   │
 │   PV accel → page_gen[ppage]++ if watched     │
 └───────────────────────────────────────────────┘
```

---

## 4. Component design

### 4.1 TinyEMU (C) changes

All changes go in new patches. The existing `tinyemu-jit-{hook,table,tlb,exports}`
patches are replaced; `tinyemu-fast-branch` is reworked.

1. **Dispatch probe at every taken control transfer.**
   * Probe in both `JUMP_INSN` (cross-page) and `FAST_JUMP_INSN` (same page).
     The probe is: hash vPC, load tag, compare, load table index.
   * On a hit, call `call_indirect region(s, pc)`. Then handle the status:
     `CONTINUE` resumes the interpreter loop at `s->pc`, `EXCEPTION` goes to
     `exception:`, `BUDGET` goes to `the_end`.
   * On a miss, bump a per-slot hotness counter. At the threshold (initially 128),
     look up the physical map (see 3). If the map also misses, enqueue a
     translation request for the physical page.
   * Requirement: when no translation exists, the interpreter must slow down by
     ≤3%. This is measured at Gate G0.
2. **Jump cache.**
   * 64k entries of `{vpc:u64, ppc_or_flags:u32, table_idx:u32}`.
   * Hash it QEMU-style: the virtual page number picks a 64-entry bucket and the
     page offset picks the entry. `sfence.vma vaddr` then clears one contiguous
     bucket, and `sfence.vma` with no address, a `satp` write, or a flush bumps a
     generation that is part of the tag. Every flush is O(1).
   * Privilege level is part of the tag, so U↔S transitions do not invalidate
     anything.
   * Prerequisite: the tagged TLB from the general MMU fix, which stops flushing
     on `set_priv` and SUM toggles. Without it, the code TLB is rebuilt on every
     trap, and the dispatcher's vPC→pPC lookups multiply.
3. **Physical map.**
   * A hash keyed by `(physical PC, mode flags)`, giving
     `{table_idx, page_gen_expected}`. Mode flags are `priv`, and `fs != 0`
     (whether FP is enabled).
   * JS fills it at install time. C reads it to refill the jump cache after
     resolving vPC→pPC through the code TLB (`target_read_insn_slow` on a miss).
4. **Watched pages and generations.**
   * `page_gen[]`: one `u32` per guest physical page (1 GiB / 4 KiB = 256k pages,
     so 1 MiB).
   * Watch bitmap: 32 KiB. A page becomes watched **when it is requested**, not
     when it is installed. A write that lands between request and install then
     bumps the generation, and the stale result is discarded at install.
   * While a page is watched, the write TLB never maps it, so every guest store
     to it takes `target_write_slow`. That path bumps `page_gen`, clears the
     watch bit, and lets later writes use the fast TLB again.
   * Also hook these writers: `phys_mem_get_ram_ptr(…, is_rw=TRUE)` (every
     virtio DMA write goes through it, see `virtio_memcpy_to_ram`), and
     `pv_memset_guest` / `pv_memcpy_guest`. Both PV ops matter: `clear_page` and
     `copy_page` are how freed code pages get reused.
   * A region checks `page_gen[ppage] == expected` once at entry and returns
     `INVALID` on a mismatch. Invalidation therefore never needs to call into JS
     or touch the function table.
5. **Single-step interpreter.** Instantiate the CPU template a second time with
   `-DSINGLE_STEP`:
   * no interrupt check on entry;
   * after one instruction, force `code_end = code_ptr` so the loop exits.

   Export it as `jit_step(s)`. It executes exactly one instruction at `s->pc`
   against the in-memory state, including exceptions (`pending_exception`) and
   CSR side effects. Uses:
   * the generic helper for instructions the translator doesn't inline;
   * the oracle for lockstep verification (§5).
6. **Slow-path memory helpers with precise faults.**
   * `jit_ld{8,16,32,64}{s,u}(s, vaddr) -> i64` and `jit_st*(s, vaddr, val) -> i32`.
   * They report faults through `s->pending_exception` / `pending_tval`, which
     `target_*_slow` already set.
   * They return a flag bit when the access was MMIO, or when it invalidated a
     watched page. The region must then exit after this instruction.
7. **`jit_poll()` import**, called once per main-loop iteration (every
   `MAX_EXEC_CYCLE`, about 1–2 ms) and from `poll_oneoff`. It installs finished
   modules. It costs about 100 ns per call.
8. **Counters** in a struct exported to JS:
   * dispatches, chain hits, jump-cache hit/miss, region exits by reason;
   * invalidations per page;
   * instructions executed in regions vs. the interpreter;
   * TLB misses and flushes.
9. **Remove** the static `jit_map` (8 MiB) and `jit_hits` (1 MiB) from
   `tinyemu-jit-table.patch`.

### 4.2 Translation unit and keys

* **Request.** The emulator sends:
  * the physical page number and the 4096 bytes of the page, plus the first
    2 bytes of the next page if a 32-bit instruction straddles the boundary;
  * the hot entry offsets known so far (accumulated per page);
  * `priv` and `fs`.
* **Region.**
  * Starts at an entry offset and includes everything reachable through direct
    branches and `jal x0` *within the page*.
  * Stops at: indirect jumps, `ecall`/`ebreak`/`*ret`/`wfi`, `sfence.vma`,
    `fence.i`, CSR writes, instructions that don't decode, the page boundary, and
    a size cap (initially 512 instructions).
  * `jal ra` (a call) ends the path with a chained exit. The return point
    (`pc + len`) is added as a likely entry for the page, so the code after a
    call gets its own region.
  * Regions from different entries in the same page may overlap; duplicated
    code is accepted.
* **Position independence.**
  * The region receives the entry vPC as a parameter. `auipc`, link values and
    exit targets are computed as `pc_param + constant`.
  * The code embeds only *physical* constants: the page index for the generation
    check, and the addresses of `s->reg` and the TLB arrays. The emulator struct
    lives at a fixed linear-memory address per build, which is part of the cache
    key.
* **Key.** `hash(page bytes) ⊕ entry offset ⊕ priv ⊕ fs ⊕ translator version ⊕
  emulator build id`. The physical page number is *not* part of the key, so
  identical pages (the same library mapped twice, page cache copies) share one
  translation.

### 4.3 Region ABI

```
(func $region (param $s i32) (param $pc i64) (result i32))   ;; status
```

* **Return status:**
  * `0` CONTINUE: `s->pc` is the next PC; the interpreter resumes there.
  * `1` EXCEPTION: `pending_exception` is set and `s->pc` is the faulting PC.
  * `2` BUDGET: `n_cycles <= 0`.
  * `3` INTERP: return to the interpreter at `s->pc`, for example after the page
    was invalidated, or for an instruction to interpret before re-entering.
* Do **not** encode status in PC bits 63:62, because they collide with kernel
  addresses. If an inline encoding is ever needed, use PC bit 0: guest PCs are
  always 2-byte aligned.
* **Registers.**
  * Guest `x1..x31` live in `s->reg[]` at region boundaries.
  * Inside a region they are wasm locals: the region loads its *live-in* registers
    at entry and stores, at each exit, only the registers *written on paths to
    that exit*. Both sets come from a forward dataflow pass over the region CFG.
  * FP registers stay in memory (phase 6 may change this).
* **Cycle accounting.**
  * A local `$n` counts the instructions executed so far.
  * Each basic block adds its length at entry: one `i32.add` per block, with no
    per-instruction cost.
  * At every exit: `s->n_cycles -= $n`.
  * Loop back-edges inside the region also check `s->n_cycles - $n > 0`, so
    timers and interrupts are still serviced within `MAX_EXEC_CYCLE`.
  * `rdinstret`/`rdcycle` stay exact because the region flushes `$n` to
    `n_cycles` before the CSR-read helper.
* **Interrupts.** Within a slice, `mip` changes only through CSR writes (which
  end the region) or MMIO stores (the helper flag forces an exit). Regions
  therefore never poll `mip`. The C dispatcher checks it after each region
  returns, as it does today at block boundaries.

### 4.4 Code generation

**Control flow.**

* Emit structured wasm from the region CFG with a Stackifier / "Beyond Relooper"
  style algorithm. The CFG is reducible: forward DAG plus natural loops, and
  in-page CFGs from compiled code are essentially always reducible.
* Fallback for irreducible CFGs: a `loop` + `br_table` label-dispatch.
* Alternative for the MVP: run `binaryen.js` (its Relooper plus a light
  optimization pass) in the compiler worker. That puts compile cost off-thread in
  exchange for a ~12 MB dependency. Decide at Gate G1 based on compile
  throughput.

**Integer ALU (RV64I, M, Zba/Zbb later).**

* Native i64/i32 ops. W-forms use `i32` ops plus `i64.extend_i32_s`.
* `div`/`rem` with RISC-V's divide-by-zero and overflow semantics, as small
  branches.
* `mulh`/`mulhu`/`mulhsu` via a 4×32-bit decomposition. Switch to wasm "wide
  arithmetic" `i64.mul_wide_*` once V8 ships it unflagged.
* Constant folding of `lui`/`auipc` + `addi`/`ld` pairs. Dead-write
  elimination for register values overwritten before any exit.

**Loads and stores** (about 45% of instructions, so most optimization effort
goes here):

```
idx   = (vaddr >> 12) & (TLB_SIZE-1)
entry = tlb_base + idx*16
hit   = i64.load(entry) == (vaddr & ~(0xfff & ~(size-1)))   ;; same check as TARGET_READ_WRITE
host  = i32.wrap(vaddr) + i32.load(entry+8)
```

On a miss, call the slow helper. If the helper reports a fault, flush state and
return EXCEPTION. If it reports MMIO or an invalidated page, flush state, set
`s->pc` to the next instruction and return INTERP.

**Same-page coalescing.** Accesses through the same base register with no
intervening write to it (`sp`-relative prologue/epilogue saves are the common
case) need only **one** TLB check when the whole offset range fits in one page.
Emit a range check (`(base+min) >> 12 == (base+max) >> 12`) and one tag compare.
If the range check fails, fall back to the per-access path. Loads and stores
use separate TLBs: one check per TLB per group.

The TLB tag folding from the MMU fix changes `vaddr` in the compare into
`vaddr ^ s->tlb_tag`. Load `tlb_tag` once at region entry; it cannot change
inside a region.

**Exits.**

* *Same-page direct exits* use an exit slot: a `u32` in a per-module memory area
  whose base comes from an imported global, so the bytes stay position
  independent.
  * `idx = i32.load(slot)`; if non-zero, `return_call_indirect(idx)`.
  * Otherwise: flush state, set `s->pc`, and `return_call $rt_link(s, pc, slot)`.
    `$rt_link` resolves the target through the jump cache, stores it in the slot,
    and tail-calls it, or returns CONTINUE if there is no translation.
  * Slots stay valid until the next epoch flush (§4.6). A target whose page was
    invalidated returns INVALID from its own generation check, which is safe.
* *Cross-page direct exits and all indirect exits* (`jalr`, `ret`):
  `return_call $rt_dispatch(s, target)`. This is a shared function in a
  per-VM runtime module that probes the jump cache inline. On a hit it tail-calls
  the region; on a miss it returns CONTINUE.
* *Budget check.* Before any chained exit: `if (n_cycles - $n <= 0)`, flush and
  return BUDGET.
* All exits flush their per-exit dirty register set and `n_cycles` before the
  tail call, because the next region reads the state from memory.

**Rare instructions** (FP, AMO, LR/SC, `fence`, CSR reads):

* *Inline:* `lr`/`sc` via `s->load_res`. `fence` is a no-op (single hart).
  `fence.tso` is a no-op. CSR **reads** of `time`/`cycle`/`instret` (the vDSO's
  `clock_gettime` path) use a non-exiting helper.
* *Generic:* flush the registers the instruction reads, set `s->pc`, call
  `jit_step(s)`, check `pending_exception`, reload the registers it may write.
  This covers FP (which keeps exact softfp semantics, fflags, rounding modes and
  NaN boxing) and AMOs. Phase 6 moves hot FP ops to native `f64` with exact flag
  computation.
* *Region terminators:* CSR writes, `sfence.vma`, `fence.i`, `ecall`, `ebreak`,
  `sret`/`mret`, `wfi`. The region exits with INTERP at that PC and the
  interpreter executes it.

**FP enable state.** If a region contains FP instructions, it is keyed on
`fs != 0`. It sets `s->fs = 3` (dirty) on the first FP write, as the interpreter
does.

### 4.5 Self-modifying code and page reuse

* The generation check at region entry plus the watch bitmap covers all write
  paths: guest stores, DMA and PV memops.
* Writing to the page of the currently running region: the store helper returns
  the INVALIDATED flag, and the region exits right after that store.
* **Thrash control.**
  * Track invalidations per page in a small hash.
  * A page invalidated more than N times (initially 8) within M slices goes on a
    cool-down list. Requests for it are suppressed for an exponentially growing
    period.
  * This covers V8 code-space pages that mix code and metadata, kernel pages
    with adjacent data, and the musl/ld.so relocation phase.
  * Validate the thresholds with the `npm` and pi workloads.
* **`fence.i` and `riscv_flush_icache`** need no special handling. The write
  tracking is exact, so they are only region terminators.

### 4.6 Asynchronous pipeline and cache management

* **Requests:** `postMessage` from the emulator worker carrying `{reqId, ppage,
  gen, bytes, entries[], priv, fs}`. Requests are deduplicated per
  `(ppage, gen)`. A page whose set of known entries grows can be re-requested;
  the newer module supersedes the older one.
* **Compiler worker:**
  * collects requests for up to about 2 ms or 64 pages (whichever comes first);
  * generates one module per batch;
  * compiles it with `await WebAssembly.compile` (off-thread; V8 tiers it up on
    its own);
  * posts back `{module, regions:[{reqId, entryOff, exportName, exitSlotCount}]}`.
* **Install** (inside `jit_poll`):
  1. `new WebAssembly.Instance(module, {env: {memory, table, rt_dispatch,
     rt_link, helpers…, exit_base}})`.
  2. For each region: `table.set(idx, export)`.
  3. Write the physical-map entry with the expected generation **only if
     `page_gen[ppage]` still equals the `gen` from the request**; otherwise drop
     the region.
* **Table and memory budget.**
  * Table indices are allocated from a growing range.
  * When live regions exceed a budget (for example 64k functions or 256 MiB of
    estimated code), run an **epoch flush**:
    * bump the jump-cache generation;
    * clear the physical map;
    * reset all exit slots (free the slot arena);
    * drop references to all instances;
    * reuse table indices.
  * No region can be running during the flush, because `jit_poll` runs from the
    main loop, outside the CPU.
* **Hotness feedback.** Requests carry entry-hit counts. The worker translates
  hotter pages first and can choose a larger region size for very hot pages.

### 4.7 Persistent and prebuilt translation caches

* Keys are content hashes (§4.2), so a translation can be reused across VM runs
  and across processes. Node offers no on-disk cache for compiled wasm code, so
  the cache stores **wasm bytes** grouped per batch, plus an index from key to
  `(file, export)`.
* **Location:**
  * `~/.cache/agentvm/<build-id>/`, or `<persistentRootDir>/jit/`;
  * plus a **prebuilt pack** produced at image build time by running a training
    workload (boot, `python3` imports, `node -e 0`, `npm --version`,
    `pi --version`) with recording enabled.
* **Startup:**
  * The compiler worker loads the pack and compiles it (Liftoff is fast).
    Kernel regions are pre-installed by physical address, because the Wizer
    snapshot fixes the kernel layout.
  * For user pages, the first request for a page whose hash is in the pack is
    answered from the precompiled module immediately, with no codegen.
* Invalidate the whole cache whenever the translator version, emulator build id
  or region ABI changes.

---

## 5. Correctness strategy

1. **Lockstep oracle mode** (`AGENTVM_JIT_VERIFY=1`, testing only):
   * Before each region run, snapshot `pc`, `x[]`, `f[]`, `fcsr`, `load_res`
     and `n_cycles`.
   * The region runs with **store logging** (verify builds of the codegen record
     `addr, size, old value`).
   * Undo the stores, restore the state, then run `jit_step` K times, where K is
     the number of instructions the region retired.
   * Compare the full register state, the PC, and the bytes written.
   * Skip the comparison when the region touched MMIO (the helper flag says so).
2. **Deterministic replay mode** (build flag `CONFIG_ICOUNT_RTC`):
   * The RTC is derived from `insn_counter`.
   * The worker delivers console input only while the guest is idle-waiting on
     it, and idle time advances virtual time to the next timer deadline.
   * Two runs (JIT off/on) are then instruction-for-instruction comparable.
   * Record `hash(pc, x[])` every 2^20 instructions and diff the traces. On a
     mismatch, re-run with finer granularity and then lockstep to find the
     faulting region.
3. **ISA tests:**
   * Upstream `riscv-tests` (rv64ui, um, ua, uc, uf, ud; `-p` and `-v`
     variants) and `riscv-arch-test`, run bare-metal in TinyEMU with hot
     threshold = 1, so every block is translated immediately.
   * Each test runs with the JIT off, on, and in verify mode.
4. **Randomized differential fuzzing:**
   * Generate random instruction pages: legal RV64GC sequences with in-page
     branches, loads and stores into a scratch page, faults, and stores into the
     page itself.
   * Execute them with the translator and with `jit_step`; compare the results.
5. **Workload suites** in CI (JIT on, verify off): the existing `npm test`,
   Python's `test_int`, `test_float`, `test_json`, `test_re`, `test_dict`,
   Node's `test/parallel` subset, `npm install` of a medium project, and pi's
   smoke test.
6. **Kill switches:**
   * `AGENTVM_JIT=0` turns the JIT off.
   * Runtime auto-disable if counters show anomalies, for example more than X%
     of dispatches ending in INVALID.

---

## 6. Observability and benchmarks

* Extend the counters (§4.1.8) with:
  * % of guest instructions retired in regions;
  * average instructions per dispatch and per chain;
  * exits by reason;
  * compile queue depth and latency;
  * install count, invalidations, cool-downs;
  * epoch flushes.
* `vm.getJitStats()` in the API, plus a `DEBUG_JIT_STATS=1` periodic dump.
* **Guest PC sampler:** record `pc` every 2^16 instructions into a ring and map
  it to symbols with `/proc/<pid>/maps`. This shows what still runs in the
  interpreter.
* **Benchmark harness:** the `mips2.js` approach (`rdinstret` + guest time),
  committed as `test/bench-jit.js`:
  * micro: Python int loop, Node int loop, Float64Array loop, `os.stat` loop;
  * startup: `python3 -c pass`, Python heavy imports, `node -e 0`,
    `npm --version`, `pi --version`;
  * system: 50× fork/exec, `npm install` of a fixture.
  * Report wall time, guest insns, MIPS, % translated, and compile CPU time.

---

## 7. Phases, deliverables and gates

Effort estimates assume one engineer familiar with the code base.

**Phase 0 — Infrastructure (1.5–2 weeks)**

* Counters, the guest PC sampler, the benchmark harness, `CONFIG_ICOUNT_RTC`
  deterministic mode and trace hashing.
* The `jit_step` single-step instantiation, and the lockstep framework running
  against the interpreter itself (a sanity check).
* **Gate G0:** deterministic mode reproduces identical trace hashes across two
  runs of the benchmark suite.

**Phase 1 — Emulator groundwork (2–3 weeks)**

* Tagged TLB: no flushes on privilege or SUM changes, generation-based flush,
  precise `sfence.vma vaddr`. This is shared with the general MMU fix and also
  speeds up the interpreter.
* Jump cache, physical map, dispatch probe in both jump paths, `page_gen` and
  watch bitmap, all RAM-writer hooks, slow-path helpers, `jit_poll`.
* Removal of the old `jit_map`/`jit_hits`.
* **Gate G1a:** with no translations installed, the interpreter is ≤3% slower
  than baseline (excluding the gains from the TLB fix). The full test suite
  passes.

**Phase 2 — Synchronous translator MVP (3–4 weeks)**

* Translator in JS: decoder (reusing `riscv-c.js`), region CFG, dataflow (live-in
  and per-exit dirty sets), structured emission, integer ALU and M, inline TLB
  loads and stores, exits returning to C (no chaining yet), the `jit_step`
  fallback for everything else, the generation check.
* Compiles synchronously in the emulator worker, one module per page. This keeps
  debugging simple.
* Verify mode, riscv-tests, the fuzzer.
* **Gate G1 (go/no-go):**
  * Python int loop ≥2.5x faster than the interpreter at steady state;
  * zero lockstep mismatches over the benchmark suite and riscv-tests;
  * `npm --version` no more than 20% slower (synchronous compile stalls are
    expected here).
  * If ≥2.5x is not reached, profile the generated code before going further.
    Likely causes: TLB path quality, too much register traffic, and Liftoff time.

**Phase 3 — Chaining and async pipeline (2–3 weeks)**

* Exit slots, `rt_link`, `rt_dispatch` and tail calls, budget checks.
* Compiler worker, batching, `jit_poll` install, generation-checked install.
* Table and epoch management, thrash control.
* **Gate G2:**
  * Python int loop ≥3.5x faster;
  * `npm --version` ≥1.3x faster on a cold JIT within the same VM, and ≥2x on
    the second run in the same VM;
  * no workload regresses by more than 5%.

**Phase 4 — Code quality (3–4 weeks, driven by profiling)**

* Same-page TLB-check coalescing, `lui`/`auipc` folding, dead writes.
* Region growth for very hot pages: larger caps, plus multi-page regions with
  multi-page generation checks.
* Inline `lr`/`sc` and AMOs. Zba/Zbb support, which also enables
  `--riscv-b-extension` for the guest V8.
* Tune hot thresholds and batch sizes.
* **Gate G3:**
  * Python int loop ≥4x faster;
  * `node -e 0` ≥1.8x faster with a warm in-VM cache;
  * MIPS on translated code ≥500.

**Phase 5 — Persistent and prebuilt cache (2 weeks)**

* Content-hash keys, an on-disk store, prebuilt pack generation in
  `image/build.sh`, pre-install of kernel regions.
* **Gate G4:** on a fresh process with the prebuilt pack, `node -e 0`,
  `npm --version` and Python imports are ≥2x faster than the interpreter, and
  `pi --version` is ≥2x faster.

**Phase 6 — FP and rollout (2–3 weeks)**

* Native-FP fast path for `fadd`/`fsub`/`fmul`/`fdiv`/`fsqrt`/`fmadd`/`fcvt`/
  compares under round-to-nearest-even, with exact fflags:
  * NV and DZ from operand classes;
  * OF and UF from result classes;
  * NX via exact-error tests (TwoSum for add/sub, an FMA-free product-error
    check for mul).
  * Anything else falls back to `jit_step`.
* Default-on behind a feature flag, soak in CI, then turn it on by default.

**Total:** roughly 16–21 weeks to the default-on state. Phases 0–2 (about
7–9 weeks) are enough to decide whether to continue.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| V8 compile/tier-up latency makes short-lived processes slower | Async compile; hot threshold; prebuilt and persistent cache; measure Liftoff→TurboFan tier-up time and, if needed, compile hot batches with `WebAssembly.compile` after a warm-up delay |
| Too many small wasm functions or instances cost memory and GC time | Batching (64 pages per module), epoch flushes, a memory budget |
| SMC thrash from V8 code space or mixed code/data pages | Per-page invalidation counters with cool-down; consider `node --jitless` under the JIT and compare (stable binary code only) |
| Generated code slower than expected because of register traffic at exits | Per-exit dirty sets; larger regions; measure stores per exit |
| Correctness bugs in rare paths (faults mid-region, MMIO, `sc`, misaligned access) | `jit_step` fallback by default; lockstep verify; fuzzing; deterministic replay to bisect |
| Device writes missed by the invalidation hooks | All RAM writes go through `phys_mem_get_ram_ptr(is_rw)` or the CPU paths; add an assert-mode checksum of watched pages at region entry in debug builds |
| Interpreter slowdown from the dispatch probe | Keep the probe to about 5 wasm ops; G1a enforces ≤3% |
| Browser builds | The design uses only standard wasm (tail calls ship in all major engines) and workers; only `receiveMessageOnPort` needs a browser equivalent (`SharedArrayBuffer` mailbox + `Atomics`) |

---

## 9. Open questions to answer early (Phase 0/2 experiments)

1. How much of Node's guest execution is in V8-generated code (anonymous
   executable mappings) versus the `node` binary? The PC sampler plus
   `/proc/<pid>/maps` answers it. It decides how much thrash control matters, and
   whether `--jitless`-under-JIT is worth trying.
2. Tier-up latency of generated modules: how long a hot region stays in Liftoff
   under default flags.
3. Whether the region cap and same-page restriction leave hot paths fragmented,
   for example in CPython's eval loop. Measure average instructions per dispatch
   and per chain.
4. Exit-slot hit rate versus `rt_dispatch` hit rate. This decides whether
   cross-page direct links (with page-generation guards) are worth adding.
5. Hand-written emitter or `binaryen.js` in the compiler worker. Decide on
   codegen throughput and code quality at G1.

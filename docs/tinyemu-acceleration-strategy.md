# TinyEMU Acceleration Strategy

Status: proposal
Audience: AgentVM maintainers
Scope: making `node` and `python3` fast *inside* the riscv64 TinyEMU guest
without giving up the single-file WASM image or the pure-Node runtime.

---

## 1. Executive summary

AgentVM runs a full riscv64 Linux inside TinyEMU compiled to `wasm32-wasi`,
hosted by `node:wasi` in a worker thread. The guest runs a real kernel and real
riscv64 `node`/`python3` binaries. Every guest instruction is *interpreted by
TinyEMU*, and TinyEMU itself is *compiled by V8*. This gives a two-level
interpreter and, for JavaScript, a two-level JIT:

```
agent code (JS)  ──V8 inside guest──►  riscv64 machine code
                                        │
                                        ▼
                              TinyEMU interpreter (C→wasm)
                                        │
                                        ▼
                                   V8 (host) runs the wasm
```

The result is a ~40–165× slowdown on CPU work and a ~20–40× slowdown on
process startup. Network and file I/O add further overhead. This is not a bug;
it is the cost of whole-system instruction emulation.

This document argues that the productive next step is **not** another
incremental interpreter tweak and **not** another JavaScript-side JIT. It is a
change of *granularity*:

> In a WASM-hosted VM, guest RAM **is** host linear memory. Therefore put work
> across the guest/host boundary in the *coarsest possible units* — whole pages
> and buffers, whole syscall paths, whole basic blocks/traces — instead of one
> guest instruction at a time.

The proposed strategy has three tiers plus cross-cutting guest shaping:

| Tier | Name | What crosses the boundary | Expected | Risk | Effort |
|---|---|---|---|---|---|
| 0 | Guest/runtime shaping | config, runtime flags | 1.2–2× on startup/I/O | low | low |
| 1 | **Paravirtual ops (PV)** | bulk memory + hot syscalls | 1.3–2.5× alloc/syscall-heavy | medium | medium |
| 2 | **WASM-native trace JIT** | whole basic blocks/traces | 3–8× CPU-bound | high | high |
| 3 | Language offload (opt-in) | whole JS/Python processes | ~native | high (isolation) | high |

Recommended sequence: **0 → 1 → (measure) → 2**, with 3 documented as an
explicit opt-in escape hatch, not a default.

### 1.1 Implementation status (this branch)

- **Tier 1 (PV bulk ops) — implemented and measured; a solid win.**
  - TinyEMU: `image/patches/tinyemu-pv-accel.patch` adds `pv_dispatch()` and
    decodes custom-0 (`funct7 = 0x70`) as a hypercall.
  - Guest kernel: `image/patches/linux-riscv-pv-accel.patch` adds
    `CONFIG_RISCV_PV_ACCEL`, routing `clear_page`/`copy_page` and the user-page
    (anonymous-fault / COW) variants through the hypercall with a software
    fallback.
  - Build: `image/build.sh` wires both patches and `-DCONFIG_PV_ACCEL` in,
    behind `PV_ACCEL=0|1` for A/B builds.
  - Measured on the acceptance image (same host, sequential warm runs, median
    of 5; A = `PV_ACCEL=0`, B = `PV_ACCEL=1`):

    | workload | A (ms) | B (ms) | speedup |
    |---|---:|---:|---:|
    | `python3 -c pass` | 680 | 630 | **1.08×** |
    | `node -e process.exit(0)` | 1770 | 1670 | **1.06×** |
    | `bytearray(200 MiB)` | 3080 | 2780 | **1.11×** |
    | `Buffer.alloc(200 MiB)` | 2605 | 2279 | **1.14×** |
    | `dict(1e6)` | 8550 | 8140 | **1.05×** |
    | `mmap`+touch 256 MiB (pure demand-zero) | 2418 | 2204 | **1.10×** |

    A direct guest probe shows the hypercall itself is correct and much
    cheaper: 20 000 page clears go from ~108 ms (software `memset`) to ~10 ms
    (**~11×**). The end-to-end gain is smaller because page-fault entry/exit,
    page allocation and PTE setup dominate the fault path.
- **Tier 0 (shaping) — evaluated, mostly not adopted.**
  - `--single-threaded-gc`: on this build it marginally helps a tight loop
    (~2%) but costs ~27% on `Buffer.alloc(200 MiB)`; it is *not* a safe global
    default, so the generic acceptance image keeps stock `node`. The pi image
    already applies it, where the tight-loop benefit dominates the agent
    workload.
  - `NODE_COMPILE_CACHE`: created but no measurable win on a 200 KB bundle.
  - Kernel config is already lean (UP, HZ=100, no modules/PCI/KALLSYMS);
    `NO_HZ_IDLE`, disabled EFI/virtio-input/compaction are left for a
    separate, individually measured change.
- **Tier 2 (JIT) — foundation implemented; blocked on in-WASM dispatch.**
  `src/jit.js` now has a tested `directTlb` mode (inlined TLB, direct memory,
  precise bail) and `image/patches/tinyemu-jit-tlb.patch` exports the TLB
  pointers. `AGENTVM_JIT=1` still hangs because dispatch happens in JavaScript
  once per basic block and a translated block corrupts control flow; see
  §7.6 for the isolated diagnosis and the required next step.

---

## 2. Measured baseline

Default image `agentvm-alpine-python.wasm` (366 MB, includes hax), Node
v22.23.2 host, 8 vCPU x86_64. Guest: Linux 6.1.0 riscv64, **1 hart**, Node
v22.23.2, Python 3.12.14, Alpine 3.21.7.

| Workload (guest) | Guest | Host native | Slowdown |
|---|---:|---:|---:|
| cold boot (warm Wizer snapshot) | 1.65–1.75 s | — | — |
| `true` (exec round-trip) | 10 ms | ~2 ms | ~5× |
| `/bin/true` (fork+exec) | 40 ms | ~1 ms | ~40× |
| `node -e "process.exit(0)"` | 1 581 ms | 38 ms | ~42× |
| `node` tight loop 5×10⁶ | 8 270 ms | 50 ms | ~165× |
| `python3 -c pass` | 640 ms | ~15 ms | ~40× |
| `python3 sum(range(2×10⁶))` | 4 310 ms | 34 ms | ~127× |
| bunzip-like busybox `while` 50 000 | 11 800 ms | — | — |

Node runtime flags on a 2×10⁶ loop:

| Invocation | Time |
|---|---:|
| default | 7 917 ms |
| `--no-opt` | 8 528 ms |
| `--single-threaded-gc` | **4 570 ms** (1.73×) |
| `--jitless` | did not finish in 600 s |

Two findings matter here:

1. `--single-threaded-gc` almost halves Node CPU time. It is already used by
   the pi image. V8's concurrent GC threads fight the single emulated hart.
2. `--jitless` is *much* slower than the default, even though it removes
   runtime code generation. That means the hot code being emulated is mostly
   **V8's own JIT output**, not V8's interpreter. A translator that only covers
   the static `node` binary will miss most of the hot path; a translator must
   handle dynamically generated code to pay off.

A synthetic 200 KB JS bundle takes ~6.0–6.2 s to load and run, and Node's
`NODE_COMPILE_CACHE` did not measurably change it. So the cost is not JS parse;
it is executing V8's generated/compiled code under emulation.

Finally, the existing experimental JIT (`AGENTVM_JIT=1`) **hung** the VM — no
output after 500 s. The AOT path is not wired to a shipped artifact. See §4.

---

## 3. Where the time actually goes

### 3.1 The interpreter

TinyEMU's `riscv_cpu_interp_x64` is a single large `switch(opcode)` loop. Each
guest instruction costs:

- instruction fetch + decode (compressed-instruction expansion included),
- register read/modify/write on `s->reg[]`,
- for every load/store: index `tlb_read`/`tlb_write` (a `(addr>>12)&255` hash),
  compare `vaddr`, then a direct host load/store; on miss a full Sv39 page walk,
- a cycle decrement and periodic block/interrupt checks.

None of this is expensive in C, but it is all executed as WASM by V8. For a
simple ALU instruction that is perhaps 20–40 host machine operations. Hence the
~100× factor. Build flags already applied (`-O3 -flto`, RV64-only decode,
`-DNDEBUG`, `wasm-opt -O3`, Wizer) have captured the easy interpreter gains
(measured ~6–10% each at the time).

`CONFIG_HZ=100`, `CONFIG_SMP=n`, `CONFIG_PREEMPT_NONE`, no modules, no PCI,
no KALLSYMS are already in the kernel config. The kernel is not the low-hanging
fruit it first appears to be.

### 3.2 The guest V8 double-JIT

For Node, the guest's V8 compiles JS to riscv64 machine code at runtime, and
TinyEMU then interprets that machine code. `--jitless` being catastrophically
slower proves the generated code is where execution lives. Any **AOT of the
static `node` binary alone is therefore insufficient**. This is the single most
important lesson from the history.

### 3.3 Kernel traps and page faults

Every syscall is `ecall` → trap → CSR updates → kernel C. Node startup issues
tens of thousands of syscalls and faults in hundreds of pages. Each anonymous
page is zero-filled by the kernel with interpreted 8-byte stores (512 stores +
loop overhead per 4 KiB page). GC-heavy JS and allocation-heavy Python multiply
this. This is *data movement*, not computation, and it is a prime candidate for
offload.

### 3.4 Device I/O

virtio-blk/9p/virtio-net paths cross into the host and back. The historical
network fixes made this correct; the default VM-wide network cap is 2 MiB/s
(`networkRateLimit` in `src/index.js`), which is a deliberate correctness cap
but a large tax on `npm`/`pip`.

---

## 4. History of attempts and why they plateaued

### 4.1 Build-time interpreter tuning — *worked, exhausted*

Commits `f4b4dcd`, `8d94bae`, `2300fca`, `c025508`, `7ad6468`,
`34360d6`, `53992d0`, `6e57ccf`:

- TinyEMU `-O3 -flto -DNDEBUG`, stripped; RV64-only decoder removed.
- Guest kernel rebuilt for performance (`-O2`) instead of size (`-Os`).
- `wasm-opt -O3` before Wizer snapshot.
- Same-page branch fast path (skip TLB lookup at timer/interrupt/privilege
  boundaries); zero-copy network reads; bulk-copy mount reads.

Combined effect: median ~9% boot, ~6–8% Node CPU, ~10% small-file workload.
Larger instruction batches were tried and **rejected** (large V8 regression).
These are real but small; the interpreter is the floor.

### 4.2 Runtime JIT (`src/jit.js`) — *architecturally dead*

Commits `eabfe33` … `07d7e6e` added a RISC-V→WASM block translator and wired it
into TinyEMU via a `jit_try_block` import. It is off by default. Why it cannot
work as written:

1. **Every memory access is a JavaScript callback.** `externalMemory` mode
   imports `env.load`/`env.store`; the generated WASM calls JS for each
   load/store. JS→WASM calls are ~1–2 orders of magnitude more expensive than
   native stores.
2. **Decoding is done from JS through WASM accessors**, one instruction at a
   time (`jit_read_u16`/`jit_read_u32`).
3. **`jit_try_block` itself is a JS import**, so *every block boundary* is a
   JS→WASM round-trip, and the interpreter must re-enter JS for every block.
4. **One `new WebAssembly.Module` per block** at runtime, with no cross-block
   linking, no register file in WASM locals, and no TLB integration.
5. **Incomplete ISA**: no FP, atomics, CSR/system, compressed-memory forms —
   i.e. it omits exactly the instructions V8 and CPython use.

Measured: with `AGENTVM_JIT=1` our benchmark produced no output in 500 s.
The direction (translate to WASM) is right; the integration is wrong.

### 4.3 AOT prototype (`tools/aot-compile.js`) — *incomplete*

Same translator, compiled offline, dispatched by an instruction-signature map.
Only 7 opcodes collected, external-memory mode, no shipped artifact, no
persistent cache. It inherits every integration problem above.

### 4.4 c2wx QEMU region JIT — *instructive, different engine*

A large sibling effort (`/root/c2wx`) built a TCG→WASM region JIT for
`qemu-system-x86_64` under Emscripten. It reached **1.41×** to `Linux version`
and **1.095×** to a later milestone, after extensive correctness work
(invalidation, indirect branches, stale body cache, interrupt delivery). It
then stalled on a post-migration `execve` lock. The relevant lessons:

- Region/trace grouping with **direct chaining** and **in-WASM dispatch** is the
  right shape.
- Per-TB module instantiation and the dispatcher were real costs (~25% of wasm
  time in dispatch alone).
- Correctness (self-modifying code invalidation, indirect branch targets,
  interrupts) dominates the engineering, not the translator.
- Its companion redesign doc explicitly deferred a "TCG-lite for TinyEMU" and
  computed-goto to a later phase.

### 4.5 Boot avoidance / persistence — *done, orthogonal*

Warm worker + Wizer pre-boot (~1.7 s cold) and the ext4-overlay persistent root
remove boot cost, but they do not make a running `node`/`python` faster.

### 4.6 What history says

- Incremental interpreter tuning is worth a few percent and is nearly exhausted.
- A JS-side JIT cannot win; a WASM-side one might.
- A static-only AOT cannot cover V8's dynamic code.
- The guest kernel is already lean; the remaining cost is instruction
  interpretation + trap/page-fault work + emulated syscalls.

---

## 5. New strategy: coarse-grained guest/host offload

### 5.1 Principle

Guest physical RAM is a contiguous `mallocz()` region inside TinyEMU's WASM
linear memory (`default_register_ram`, `iomem.c`). Guest virtual→host addresses
are already cached in `s->tlb_read/write/code` as
`{ vaddr, mem_addend = host_ptr - vaddr }`. The host therefore has *direct,
cheap* access to all guest memory. We should exploit that.

Three mechanisms, in order of increasing ambition and decreasing certainty.

---

## 6. Tier 1 — Paravirtual bulk operations (PV)

**Idea.** Add a privileged hypercall path from the guest to TinyEMU and use it
for semantically trivial bulk work that is currently a loop of interpreted
loads/stores. The host executes it with WASM bulk-memory instructions in one
shot.

### 6.1 Hypercall mechanism (implemented)

RISC-V reserves custom opcodes `0x0b`, `0x2b`, `0x5b`, `0x7b`. The
implementation uses **custom-0 with a magic `funct7 = 0x70`**:

- Encoding: `.insn r 0x0b, <op>, 0x70, x0, a0, a1`.
- `funct3` = operation: `0` memset, `1` memcpy, `2` clear_page, `3` copy_page.
- Arguments in `a0..a2` (x10..x12); result in `a0` (`0` = done, `1` = run the
  software path).
- TinyEMU's `pv_dispatch()` translates the guest virtual range with the same
  `get_phys_addr()` walk the interpreter uses, then `memset`/`memcpy` the RAM
  directly and marks the dirty pages. Non-RAM (MMIO, unmapped) ranges return
  `1` and the guest falls back.
- The kernel wraps the raw instruction in `arch/riscv/mm/pv_accel.c` and uses
  it for `clear_page`/`copy_page` via `arch/riscv/include/asm/page.h`.

This is a few dozen lines in TinyEMU plus one small kernel file. It stays
pure-Node: no runtime dependency, no second WASM module, and no new escape
surface (the host only moves guest data; it never executes guest code).

A custom CSR read via `csrrw` is an equivalent alternative; the custom opcode
is simpler and needs no CSR privilege plumbing.

### 6.2 Operations, highest ROI first

| Op | Guest hook | Host implementation |
|---|---|---|
| `PV_CLEAR_PAGE(dst)` | `clear_page()`, `mm/page_alloc.c`, `mm/memory.c` | `memset(p, 0, 4096)` |
| `PV_COPY_PAGE(dst, src)` | `copy_page()`, fork/cow | `memcpy(p, q, 4096)` |
| `PV_MEMCPY/MEMSET/MEMCMP` | `lib/string.c`/riscv `lib/*` | bulk |
| `PV_CSUM_PARTIAL` | `arch/riscv/lib/csum.c` | integer loop |
| `PV_COPY_USER` | `copy_to_user`/`copy_from_user` | bulk |
| `PV_RANDOM` | `arch_get_random_*` | host CSPRNG |
| `PV_FUTEX_WAKE` | futex fast path | host wake |
| `PV_MMAP_ZERO` | demand-zero fault | bulk zero |

The **page-zeroing path is the headline**: every anonymous page a process
touches — and Node/Python touch many — costs ~512 interpreted stores in the
kernel today. Replacing that with one native fill is a 100–1000× win on that
fraction of kernel work.

### 6.3 Reaching user space

The kernel path alone already covers page faults, `fork`, `read`/`write`
user↔kernel copies, and networking checksums. To reach *user-space* `memcpy`
(V8 string building, CPython allocations), add one tiny syscall
(`__NR_pv_memcpy`) or a vDSO entry, and ship a **musl built with PV-aware
`mem*`**. Because we already build the guest rootfs, replacing musl is a
build-time change with no runtime dependency. Keep a normal fallback so
non-patched binaries still work.

### 6.4 Expected impact and honest limits

- Large win on startup, allocation, GC, `fork`/`exec`, and I/O copy paths.
- **No win** on pure ALU/FP JS loops; those need Tier 2.
- Correctness surface is small (data movement plus a few syscalls).

### 6.5 Risk controls

- Gate each op behind a guest kernel config and a TinyEMU build flag.
- Keep the pure-software implementation as the fallback when the hypercall is
  unavailable, so an old kernel/new emulator mismatch degrades to correctness.
- Add a differential test: same workload with PV on/off, compare output and
  checksums over guest RAM regions touched.

---

## 7. Tier 2 — WASM-native trace JIT done right

This is the only path to a large win on CPU-bound `node`/`python`. The old
attempt failed on integration, not on the idea. The redesigned architecture:

### 7.1 Fix the boundary (the crucial change)

- **Shared memory.** Patch the TinyEMU link to *import* its linear memory
  (`--import-memory`, already supported in the WASI build), create the
  `WebAssembly.Memory` in JS, and pass it to both TinyEMU and the JIT.
- **Shared function table.** The JIT module exports a `WebAssembly.Table`.
  TinyEMU imports it and calls translated blocks with `call_indirect` — a
  **WASM→WASM call, not a JS import**. Replace the current
  `env.jit_try_block` JS import.
- **Direct memory with inlined TLB.** A translated load computes
  `idx=(vaddr>>12)&255`; compares `i64.load(tlb_base + idx*16)` to
  `vaddr & ~(mask)`; on hit computes `host = i32.wrap(vaddr) + i32.load(entry+8)`
  and does a plain `i64.load` through the imported memory; on miss calls an
  imported **WASM** slow path (`target_read_slow`). No JS on the fast path.
  Same for stores and code fetch. This mirrors TinyEMU's own inline fast path.
- **Decode once, not per execution.** Translation reads guest bytes from the
  host once; the resulting function is cached keyed by
  `(pc, code-page hash, CPU mode)`.
- **Batch compilation.** Compile many blocks/traces into one module with
  multiple exports, then `table.set(slot, fn)`. Compile in a dedicated
  `worker_threads` compiler so the vCPU keeps interpreting.

### 7.2 Trace formation

Start with single blocks, then extend to **traces through taken branches**
(DynamoRIO/TraceMonkey style) rather than c2wx-style full CFG regions. Traces
amortize dispatch and expose cross-block optimization. Use a small hot counter
and a side-trace for the non-dominant branch. This subsumes the "region" idea
with far less bookkeeping.

### 7.3 Correctness plan (do this first)

- A differential harness: execute a block/trace once in the interpreter and
  once in the JIT from identical CPU/RAM state, compare registers, CSRs, and
  the touched RAM. This was the single most valuable tool in c2wx.
- Invalidation: hook code-page writes (`target_write_u*` into `tlb_code`
  pages) and `sfence.vma` to bump a global code-generation counter; a cached
  trace records the counter and is discarded when it changes.
- Handle: x0, misaligned/cross-page accesses, MMIO (always slow path),
  traps/exceptions (bail to interpreter), atomics (single hart → LR/SC trivial),
  `fence` (no-op, already patched), FP rounding modes (WASM default; bail for
  non-default).
- The interpreter is always authoritative; the JIT is a pure accelerator.

### 7.4 ISA coverage phases

1. RV64I + M + C + loads/stores + branches/jumps (integer loops, pointer
   chasing, CPython hot loops, V8 baseline code).
2. RV64 F/D: map FP registers to WASM `f64`/`f32` locals; bail on non-default
   `frm`. Needed for most real JS.
3. Atomics, CSR, `SYSTEM` fast paths.
4. Persistent on-disk trace cache keyed by guest binary hash.

### 7.5 Proof-of-concept result

`tools/jit-spike.js` (added with this proposal) emits the same straight-line
integer/load/store RISC-V-shaped block twice: once with the current
JS-callback memory model (`env.load`/`env.store` per access) and once with the
proposed model (imported shared `WebAssembly.Memory`, TLB entry checked in
generated WASM, plain `i64.load`/`i64.store` on a hit, WASM slow path on a
miss). On Node v22:

| units | iterations | callback | direct + inlined TLB | speedup | checksums |
|---:|---:|---:|---:|---:|:--:|
| 100 | 30 000 | 1 191.8 ms | 26.3 ms | **45.4×** | match |
| 400 | 20 000 | 3 335.4 ms | 69.3 ms | **48.1×** | match |
| 1000 | 30 000 | 12 143.8 ms | 269.8 ms | **45.0×** | match |

This is the memory-access path only; dispatch and decoding still need fixing.
But it shows why the old JIT could never win and that the proposed integration
removes the dominant per-access cost. Run it with:

```bash
node tools/jit-spike.js [units] [iterations]
```

### 7.6 Implementation status and the remaining blocker

The direct-TLB translator is implemented on `perf/tinyemu-jit`:

- `src/jit.js` `directTlb` mode: imports the emulator memory, inlines the TLB
  check in generated WASM, does direct loads/stores, and **bails precisely** on
  a TLB miss, unaligned access or cross-page access by returning the faulting
  instruction's PC with the high bit set. Everything before the access has
  already committed, so the interpreter resumes correctly. Stores check the
  write TLB, so write protection cannot be bypassed.
- `image/patches/tinyemu-jit-tlb.patch` exports `jit_tlb_ptr(state, which)`.
- `isSupportedInstruction()` strictly rejects the M extension.

Several real translator/decoder bugs were found and fixed while bringing this
up (each is covered by a unit test):

- 64-bit shift-right width: `srlw`/`sraw`/`srliw`/`sraiw` shifted the full
  64-bit register instead of the sign/zero-extended low 32 bits;
- `sraiw` tested the wrong instruction bit for the arithmetic shift;
- the compressed decoder expanded `c.lw`/`c.ld`/`c.lwsp`/`c.ldsp` to `slti`
  instead of loads (wrong opcode), decoded CA-format `c.sub`/`c.xor`/`c.or`/
  `c.and`/`c.subw`/`c.addw` with the wrong discriminator, dropped the sign of
  `c.lui`, used the wrong offset fields for `c.lwsp`/`c.ldsp`/`c.swsp`/
  `c.sdsp`, and took `c.addi4spn`'s `imm[5:4]` from the wrong bits;
- `c.addiw` was missing entirely;
- `JAL`/`JALR` hard-coded the link address as `pc + 4`, which is wrong for
  2-byte compressed instructions (e.g. `c.jalr`).

Two independent checkers now exist:

- `tools/check-riscv-c.js` assembles a corpus with `riscv64-linux-gnu-as` and
  compares every compressed expansion against the assembler (ALU, loads/stores,
  shifts, branches and jumps all match).
- `AGENTVM_JIT_VERIFY=1` runs `src/riscv-ref.js`, an independent BigInt
  reference interpreter, differentially against every translated block. It
  found and helped fix the `JALR` link bug and now reports **zero** mismatches
  across ALU/load/store/branch blocks (the reference's stores are undone before
  the JIT runs so load-after-store blocks are checked cleanly).

So the translator itself is now believed correct. Full-VM boot under
`AGENTVM_JIT=1` still does not complete. The blocker is the dispatch model:
TinyEMU calls `jit_try_block` from JavaScript once per basic block, and the
generated block returns after every branch. A hot loop therefore crosses
WASM→JS→WASM once per iteration, which is far more expensive than the few
instructions it saves.

Two mitigations are implemented on top of the translator:

1. **Self-looping blocks.** A block whose terminal branch targets its own start
   (bottom-tested loop) is emitted as a WASM `loop` that runs up to
   `LOOP_BUDGET` (64) iterations per host call.
2. **Trace decoder.** The worker follows forward (exit) branches through a loop
   body until the back edge, so a **top-tested** loop is compiled as one
   self-looping trace rather than stopping at the first branch.
3. **Loops only.** Non-loop blocks cannot amortize the per-block host dispatch,
   so by default only loop traces are compiled (`AGENTVM_JIT_ALL_BLOCKS=1`
   restores compiling every block). This keeps boot close to normal speed.

**In-WASM dispatch is now implemented.** TinyEMU exports its indirect function
table (`--export-table --growable-table`) and owns a direct-mapped
`{pc, tableIndex, cycles}` map plus a C `jit_try_block()` that calls compiled
traces with `call_indirect`. The host loads each compiled trace into the table
and writes the map entry; the only JavaScript that remains is a `jit_compile`
hook invoked once per hot PC (after 50 hits in C). Steady-state execution never
returns to JavaScript.

Measured on the acceptance image:

| workload | JIT off | JIT on | speedup |
|---|---:|---:|---:|
| boot | 1572 ms | 1618 ms | 0.97× |
| call-free ALU loop (50 M iters) | 2760 ms | 176 ms | **15.68×** |
| call-free load/store loop (5 M iters) | 250 ms | 113 ms | **2.21×** |
| `node` integer loop | 2550 ms | 2593 ms | 0.98× |
| `node` string loop | 2761 ms | 2761 ms | 1.00× |
| `python3 sum(range(2e6))` | 5046 ms | 5006 ms | 1.01× |
| `python3` for-loop (1e6) | 22584 ms | 23500 ms | 0.96× |

With the JavaScript per-boundary hook gone, Node and Python are at parity and
the loop speedup rose from 7.8× to 15.7× (the remaining 2–4% on some workloads
is the C-side hot counter and the non-translated cold code).

Codegen improvements that produced these numbers:

- **Guest registers live in WASM locals** for the duration of a trace, instead
  of being reloaded from memory for every instruction (the interpreter's C
  compiler does the same). Registers are loaded once at trace entry and stored
  back only at trace exits.
- **Direct `s->pc` reads** as two 32-bit ints with a Number cache key.
- **Loop-only traces** with a WASM-internal loop (up to 64 iterations per host
  call).
- **The C dispatcher subtracts `cycles` from `s->n_cycles`**, so the interpreter
  still returns to check interrupts between traces, and a `bail` result (TLB
  miss / unaligned / cross-page) resumes the interpreter at the exact faulting
  instruction.

`AGENTVM_JIT=1` still opts in (the default remains off). The build applies
`image/patches/tinyemu-jit-table.patch` and links with
`-Wl,--export-table -Wl,--growable-table`.

### 7.7 Expected impact

A correct WASM-native translator with direct memory and trace chaining should
be 3–8× over the interpreter on compute-bound code. It is a large project; the
MVP (phase 1 ISA, single blocks, differential harness, one workload) is the
gate. If the MVP does not beat the interpreter by ≥2× on a Node loop, stop.

### 7.8 Alternatives to writing one

- **Put the riscv64 guest under QEMU TCG→WASM instead of TinyEMU**, reusing the
  c2wx HCI/region machinery. QEMU TCG already handles every instruction, MMU,
  atomics and FP, and its region JIT reached ~1.4× on x86. Cost: QEMU is far
  larger and its cold boot is worse; the container2wasm TinyEMU path is fast
  precisely because it is small.
- **Reuse an existing RISC-V interpreter's design** but keep TinyEMU's memory
  model.

These are worth a spike before committing to a from-scratch translator.

---

## 8. Tier 3 — Language offload (opt-in, maximum speed)

If the goal is *maximum* speed for the agent workload and the threat model
allows it, run the guest's JS/Python on the **host** runtimes (which are native
x86_64/arm64) while keeping the VM as the filesystem/network/process authority.

Design sketch:

- Guest `/usr/bin/node` becomes a thin launcher that sends `{argv, cwd, env,
  script}` over a host-only channel (virtio-serial, vsock, or an extra
  loopback TCP listener) to a host service.
- The host service runs the script in a `worker_threads` isolate with
  `fs`/`child_process`/`net` shimmed back to the VM (the guest root is already
  an ext4 image + writable overlay on the host; `pip`/`npm` trees live there).
- Pure-JS workloads run at ~native speed. Native addons, weird `procfs`
  dependencies, and `sigaction`/`ptrace` fall back to the emulated Node by
  re-executing the real binary in the guest.
- Python analogously with a host CPython; ABI-sensitive wheels fall back.

Trade-offs:

- **Isolation is reduced for accelerated commands.** Mitigate with an explicit
  `accelerate: 'node'|'none'` option, a locked-down host sandbox (Node
  permissions, seccomp, a dedicated unprivileged uid, no network by default),
  and a documented guarantee that only workspace/user code — never arbitrary
  fetched binaries — is accelerated.
- It is a product decision as much as a technical one. Document it as an
  escape hatch, not the default.

A weaker but safer variant: offload only the **agent framework's own startup**
(pi's Node bundle) and keep user-submitted code emulated.

---

## 9. Tier 0 — Cross-cutting guest/runtime shaping (do now)

These are cheap, independent, and measurable.

### 9.1 Node

- `--single-threaded-gc` (already in the pi image): measured **1.73×**.
- `--max-semi-space-size` / `--max-old-space-size` tuned to avoid GC thrash on
  a 1 GiB guest.
- `NODE_COMPILE_CACHE` (works on guest Node 22; a cache dir is created) for
  large bundles — measure on the real pi bundle, not a synthetic one.
- **User snapshot** (`--build-snapshot`/`--snapshot-blob`) for the pi CLI so
  its module graph is pre-loaded. Verify against the real bundle; needs an
  entry script and snapshot-compatible modules.
- Consider a statically linked Node to avoid the dynamic loader, and
  `--no-expose-wasm`/`--disable-proto` where irrelevant.

### 9.2 Python

- `python3 -S -E` (skip `site`/user site) where imports allow.
- `PYTHONDONTWRITEBYTECODE=1`, `PYTHONHASHSEED=0` (less startup work).
- For installs, prefer a statically built `uv` (if buildable for riscv64) over
  `pip`; otherwise `pip --no-cache-dir --no-compile`.
- Ship precompiled `.pyc` for the standard library and common packages.

### 9.3 Kernel

The config is already lean. Remaining candidates, each independently tested:

- `CONFIG_NO_HZ_IDLE=y` (currently `CONFIG_HZ_PERIODIC=y`): stop the 100 Hz
  tick while idle.
- Disable `CONFIG_EFI`/`CONFIG_EFI_STUB` (boot is via bbl/direct, not EFI).
- Drop `CONFIG_VIRTIO_INPUT`, `CONFIG_COMPACTION`, and `CONFIG_DEBUG_KERNEL`
  sub-options not required for the agent profiles.
- Ensure the vDSO is enabled so `clock_gettime`/`gettimeofday` avoid traps.

### 9.4 Network

- Re-evaluate the 2 MiB/s `networkRateLimit` default now that the TCP stack is
  correct; expose it and measure `npm`/`pip` with a much higher cap or
  unlimited. This is a direct multiplier on install time.

### 9.5 Host / TinyEMU build

- **PGO of TinyEMU.** Build with `-fprofile-instr-generate`, run a
  representative guest workload (Node loop + npm install), rebuild with
  `-fprofile-instr-use`. Expect 5–15% on a branchy interpreter, low risk.
- Tune the `poll_oneoff` wait quantum and the ring-buffer wake path
  (`src/worker.js`); the current loop polls in short intervals
  (`ringReader.waitForIO(Math.min(10, remaining))`). Measure idle CPU and
  wake latency.
- Remove the `str.replace`/`Buffer` churn in the exec sentinel parser for large
  outputs.

---

## 10. Roadmap

**Phase 0 (1–2 weeks): measure and shape.**
Instrument guest instruction counts per workload; add the Tier 0 changes;
re-measure. Deliverable: a repeatable bench (`test/bench-perf.js`) and a phase
table. Exit: ≥5% on two workloads, no regressions.

**Phase 1 (2–4 weeks): PV bulk ops.**
TinyEMU hypercall + guest `clear_page`/`copy_page`/`mem*`. Differential tests.
Exit: ≥1.2× on Node/Python startup and an allocation benchmark; correctness
green.

**Phase 2 (spike, 1–2 weeks): pick the JIT engine.**
Differential harness + one translated block executed under the *new* shared-
memory/inline-TLB/table-dispatch design, benchmarked against the interpreter.
This is a go/no-go for a from-scratch TinyEMU JIT versus the QEMU-TCG option.
Exit: a documented per-instruction speedup on a real Node loop.

**Phase 3 (1–3 months): trace JIT MVP.**
ISA phase 1, single blocks, trace formation, persistent cache, invalidation
tests. Exit: ≥2× on the same loop; otherwise stop and lean on Tier 1/3.

**Phase 4 (optional): language offload.**
Only if the product accepts the isolation trade-off and Phases 1–3 leave a
large residual.

---

## 11. Measurement plan

Use `test/bench-perf.js` (added with this proposal) plus a new
`npm`/`pip`/pi workload bench. For every candidate record:

- host wall time, host CPU time, and guest instruction count if available;
- the phase split: boot, process-start, user CPU, kernel CPU, block I/O,
  network, idle/poll;
- median of ≥5 runs, p95, and exact image hash;
- correctness (output + a workspace checksum) for every run.

Promotion gate: median ≥5% better, p95 no worse than +10%, correctness green,
and the same image otherwise unchanged.

---

## 12. Risks

- **Trace-JIT correctness** (invalidation, indirect branches, interrupts) — the
  reason c2wx needed so long. Mitigate with the differential harness and a
  permanent interpreter fallback.
- **PV ABI drift** — kernel and emulator must agree. Version the hypercall and
  degrade gracefully.
- **Overfitting to `node -e`** — the real workload is the pi agent and `pip`;
  benchmark those.
- **Diminishing returns** — if Phase 1+3 do not clear the gates, the honest
  answer is that full-system emulation has a floor and Tier 3 is the only way
  past it.

---

## 13. Recommendation

1. **Do not** invest further in `src/jit.js` as-is; it is architecturally
   unable to win (JS callbacks on every access and every block boundary).
2. **Do** ship the Tier 0 shaping changes and re-baseline with the real pi/pip
   workloads.
3. **Do** build the TinyEMU hypercall + `clear_page`/`copy_page` first: it is
   small, safe, and targets the kernel data-movement cost that dominates
   startup and GC.
4. **Then** run the JIT differential spike with shared memory, an inlined TLB,
   and WASM→WASM table dispatch. Only proceed if the spike shows ≥2× over the
   interpreter on a real Node loop.
5. Keep language offload documented as an explicit, opt-in escape hatch with a
   clearly stated reduction in isolation.

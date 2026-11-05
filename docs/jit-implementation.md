# Region JIT implementation notes

Companion to [docs/jit-plan.md](./jit-plan.md). This file records what has
landed, what deviates from the plan, and how to run the new pieces.

## Status

| Phase | State | Notes |
|---|---|---|
| 0 — infrastructure | landed | C counters, guest-PC sampler, deterministic trace ring, `jit_step`, host stats, benchmark harness, JS unit tests |
| 1 — emulator groundwork | landed | jump cache, physical map, page generations/watch bitmap, dispatch probes, RAM-writer hooks, `jit_poll`, single-step helper |
| 2 — synchronous translator MVP | landed (integer + M, FP/AMO via `jit_step`) | page-confined CFG, wasm emitter, inline TLB, precise bail, synchronous install |
| 3 — chaining + async worker | landed | compiler worker with batching and pre-compiled (warmed) modules; thrash control; chaining implemented but opt-in (no measured gain) |
| 4 — code quality | partly | used/written register sets, inline store fast path, load/store slow helpers, shared exit tail; no TLB coalescing yet |
| 5 — persistent cache | scaffolding only | `src/jit/cache.js` exists; no prebuilt pack |
| 6 — FP fast path | not started | FP goes through the interpreter |

The region JIT is **opt-in** with `AGENTVM_JIT_V2=1`. The old loop JIT
(`AGENTVM_JIT=1`) is unchanged and still works.

## Deviations from the plan

* **Region ABI.** The plan proposed `(s: i32, pc: i64) -> status`. The
  implementation passes the physical page and expected generation too:
  `(s: i32, pc: i64, ppage: i32, expected_gen: i32) -> i32`. This keeps
  translations position independent across physical pages with identical
  content, while still allowing the generation check.
* **Dispatch probe placement.** The probe runs at every taken branch
  (`FAST_JUMP_INSN`) and at the block fetch path. It is a jump-cache lookup,
  so the hot path never hashes a vPC on a hit.
* **No tagged TLB yet.** The inline probe uses the existing
  `{ vaddr, mem_addend }` TLB entry, so it already handles page-offset bits the
  same way as `target_read_uN`.
* **Synchronous compile.** Phase 2 compiles and instantiates on the emulator
  thread inside `jit_request_region`. The async compiler worker slots into the
  same request/install API later.
* **Watched writes.** A watched page is removed from the write TLB, so every
  guest store to it takes `target_write_slow`, bumps the generation and clears
  the watch bit. DMA (`phys_mem_get_ram_ptr(is_rw)`) and the PV
  `clear_page`/`copy_page` paths notify the same code.
* **Rare instructions.** FP loads/stores/ALU and AMO run through the
  `jit_step` single-instruction interpreter inside the region. System/CSR,
  `sfence.vma` and `fence.i` still end the region and return `INTERP` at that
  PC because they can change privilege/MMU state.

## New files

```
src/jit/wasm.js        binary writer, opcodes, label-depth helper
src/jit/decode.js      compressed expansion + instruction classification
src/jit/region.js      page-confined CFG builder
src/jit/emitter.js     region -> wasm (registers in locals, inline TLB)
src/jit/compiler.js    compileRegion/compileBatch + content-hash keys
src/jit/engine.js      request -> batch -> install (async worker or synchronous)
src/jit/compiler-worker.js  off-thread codegen + compile + warm-up
src/jit/verify.js      lockstep verifier and exit profiler (debug)
src/jit/cache.js       on-disk translation cache (Phase 5 scaffolding)
src/jit/stats.js       C/JIT counter layouts and host counters
src/jit/sampler.js     guest-PC sample ring reader
src/jit/trace.js       deterministic trace ring reader / diff
test/jit-v2.test.js    unit + differential tests (no image required)
test/bench-jit.js      wall time / guest uptime / optional MIPS harness
```

C side: `image/patches/tinyemu-jit-v2-core.patch` (landed) and
`image/patches/tinyemu-jit-v2-pv.patch` (PV write hook, applied when
`PV_ACCEL=1`). These are additive: the older `tinyemu-jit-*` patches are still
applied so `AGENTVM_JIT=1` (the loop JIT) keeps working. Removing the old
`jit_map`/`jit_hits` tables is a follow-up cleanup.

## Enabling it

```bash
# Build an image with the new C infrastructure.
cd image
C2W=/path/to/c2w ./build.sh /tmp/agentvm-jit2.wasm

# Run with the region JIT.
AGENTVM_JIT_V2=1 node test/basic.test.js /tmp/agentvm-jit2.wasm

# Diagnostics
AGENTVM_JIT_V2=1 DEBUG_JIT=1 node test/basic.test.js /tmp/agentvm-jit2.wasm
AGENTVM_JIT_V2=1 AGENTVM_JIT_SAMPLE=1 node test/bench-jit.js --wasm /tmp/agentvm-jit2.wasm
AGENTVM_JIT_V2=1 AGENTVM_JIT_TRACE=1 DEBUG_JIT_STATS=1 node test/bench-jit.js --wasm /tmp/agentvm-jit2.wasm --json
```

`vm.getJitStats()` returns the latest host + guest counters;
`vm.getJitSamples()` and `vm.getJitTrace()` return the diagnostic rings.
`DEBUG_JIT_STATS=1` posts them once per second (the emulator's main loop
never returns, so the exit-time post is normally unreachable); trace messages
are incremental, so `getJitTrace()` accumulates the whole run.

Deterministic mode (Phase 0 gate) needs an image built with:

```bash
ICOUNT_RTC=1 C2W=/path/to/c2w ./build.sh /tmp/agentvm-jit2-det.wasm
```

That sets `CONFIG_ICOUNT_RTC`, so the RTC is derived from retired
instructions instead of the host clock. Two runs can then be compared with
`getJitTrace()`.

## Lockstep verification

`AGENTVM_JIT_V2_VERIFY=1` (`src/jit/verify.js`) implements the plan's
oracle mode (§5.1) on the host side, without a C rebuild. Every installed
region is called through a JS trampoline that snapshots `pc`/`x[]`/`n_cycles`,
runs the region with a logging store helper (recording pre-images), undoes the
stores, re-executes the same instruction count with `jit_step` (the real
interpreter) and compares PC, registers and written bytes. Mismatches go to
`/tmp/jit-verify.log` (override with `AGENTVM_JIT_V2_VERIFY_LOG`) together
with a dump of the code page; the oracle's result is kept, so the guest keeps
running (`AGENTVM_JIT_V2_VERIFY_KEEP=region` keeps the region's instead).
Calls that ran a `jit_step` helper inside the region are not compared.

This caught the RVC bug below on its first run. Differential tests against
`src/riscv-ref.js` can't catch decoder bugs, because the reference consumes
the same expanded words as the translator.

**Fixed:** `src/riscv-c.js` had wrong immediate layouts for `C.LD`, `C.SD`,
`C.LWSP`, `C.LDSP`, `C.SWSP` and `C.SDSP` (about 9k encodings, for example
`c.sdsp s0, 32(sp)` stored to `sp+256`). That was the kernel-oops bug. The
expander now matches LLVM's decoder for every non-hint 16-bit encoding.

## Fixes and measurements (build `agentvm-jit7`)

C (`tinyemu-jit-v2-core.patch`):

* `jit_step` no longer takes an interrupt at the interpreter's block-boundary
  check (it must retire exactly the instruction at `s->pc`).
* `jit_store_helper` detects MMIO by comparing the write-TLB tag with the
  store's page (a device write leaves a stale entry for another page).
* Faulting loads and stores are charged 2 cycles like the interpreter: the
  region counts the access and `mmu_exception` counts the exception.
* Physical map: 64k entries with bounded probing (16). Before this, a full
  16k map made every jump-cache miss scan all slots and rejected every new
  install (`npm --version` went from 13 s to 170 s).
* `jit_load_helper` / `jit_load_value_ptr`: slow-path loads inside regions.
  TinyEMU flushes the TLB on every privilege change, so previously the first
  load after each trap ended the region.
* `jit_phys_capacity` export, so the host can start epochs in time.

JS:

* Registers: load only those a region uses, flush only those it writes.
* Stores: inline write-TLB fast path; the helper is only called on a miss.
* Cycle counting: one add per block transition (exits add the static rest).
* `s->pc` and `n_cycles` are written directly (`pc_ptr` global).
* Batched install: `request()` queues, `poll()` builds one module per batch.
* Pure CSR reads and `c.nop` run inside regions.
* Code emission uses a growable `Uint8Array` (codegen ~15x faster).

`node test/bench-jit.js --repeat 3`, wall seconds, same image, two
interleaved rounds (i7-7700HQ). "first" = first run in a fresh VM,
"warm" = best of 3 in the same VM:

| Workload | interp first | JIT first | interp warm | JIT warm | warm speedup |
|---|---|---|---|---|---|
| python-int-loop | 13.9-15.2 | 8.8-9.0 | 11.4 | 3.8 | 3.0x |
| python-heavy-imports | 6.3 | 7.2-7.6 | 5.6 | 4.5 | 1.25x |
| python-startup | 0.72 | 0.55 | 0.72 | 0.54 | 1.3x |
| node-int-loop | 4.2 | 4.5-4.8 | 2.3 | 1.5 | 1.6x |
| node-f64-loop | 16.6-17.1 | 15.7-15.9 | 16.3 | 14.4 | 1.13x |
| node-startup | 1.75-1.87 | 0.90-0.98 | 1.71 | 0.84 | 2.0x |
| npm-version | 7.0-7.1 | 14.8-17.5 | 6.4 | 7.6-13 | 0.5-0.85x |
| stat-loop | 1.0-1.4 | 1.8-2.7 | 1.0 | 1.0 | 1.0x |
| fork-exec-50 | 1.9-2.0 | 1.85-1.98 | 1.88 | 1.62 | 1.16x |

Single runs vary by up to 1.7x for the interpreter itself, so use
`--repeat` and interleave modes when comparing.

Remaining cold-start cost is synchronous translation on the emulator thread
(about 0.18 ms codegen + 0.08 ms instantiate per region, 25k regions over the
suite). npm also re-translates V8-generated code in every new process. Next
steps from the plan: the async compiler worker (Phase 3), chaining (most
region exits are `jalr`), and the persistent/prebuilt cache (Phase 5).


## Async compiler, shared exit tail, chaining (build `agentvm-jit8`)

* **V8 compiles wasm lazily.** `new WebAssembly.Module` only validates; each
  function is compiled by Liftoff on its first call. For regions that happened
  on the emulator thread, in the middle of guest execution (~0.7 ms for the
  116-instruction memcpy region), and none of it showed in the compile stats.
* **Shared exit tail.** Exits set `$n`/`$status`/`$tmp64` and branch to one
  tail per region that flushes the written registers once. `Code` tracks the
  block nesting depth, so branch depths stay correct inside nested `if`s. The
  memcpy region went from 23 KB to 9 KB and its lazy compile from 0.70 ms to
  0.24 ms.
* **Compiler worker** (`src/jit/compiler-worker.js`, default on;
  `AGENTVM_JIT_V2_ASYNC=0` for the synchronous batch path). `request()`
  queues; `poll()` sends one batch per main-loop iteration with each page
  copied once. The worker builds one module per batch, compiles it, and calls
  every region once against a dummy environment (it returns at the generation
  check). The compiled code lives in the shared native module, so the
  emulator thread gets compiled functions: first call 0.273 ms → 0.001 ms per
  region. The emulator thread only instantiates and installs: about 0.01 ms
  per region, against ~0.5 ms before.
* **Chaining** (opt-in, `AGENTVM_JIT_V2_CHAIN=1`). C exports
  `jit_chain_ptr()` (jump cache, `jit_jump_gen`, `priv`/`fs`/`mip`/`mie`,
  and a `chained` counter). A single chain-runtime module imports the
  function table. It returns CONTINUE when the budget is spent, an interrupt
  is pending, or the jump cache misses; otherwise it does
  `return_call_indirect`. Regions `return_call` it.
  * Don't import the table into each region instance. V8 keeps a dispatch
    table per importing instance and updates all of them on every
    `table.set`, which made installs O(n²): with the table imported per
    region, 27% of all CPU went to `Instance`/`table.set`.
  * Result: 90% of region transitions stay in wasm (200M of 220M), but wall
    time doesn't change. Transitions are no longer the bottleneck; region
    bodies are. The verifier can't cover chaining (its trampolines sit in the
    table), so it is off by default.

Final numbers (`bench-jit --repeat 3`, two interleaved rounds, same image,
seconds; "first" = first run in a fresh VM incl. translation, "warm" = best of
3 in the same VM; best of the two rounds each):

| Workload | interp first | JIT first | interp warm | JIT warm | warm | first |
|---|---|---|---|---|---|---|
| python-int-loop | 13.27 | 7.27 | 10.69 | 3.39 | 3.15x | 1.83x |
| python-heavy-imports | 5.97 | 5.49 | 5.46 | 4.16 | 1.31x | 1.09x |
| python-startup | 0.71 | 0.53 | 0.70 | 0.52 | 1.35x | 1.34x |
| node-int-loop | 3.73 | 3.28 | 2.28 | 1.33 | 1.71x | 1.14x |
| node-f64-loop | 16.46 | 14.56 | 16.10 | 14.54 | 1.11x | 1.13x |
| node-startup | 1.73 | 0.84 | 1.71 | 0.82 | 2.09x | 2.06x |
| npm-version | 7.32 | 7.38 | 6.06 | 5.78 | 1.05x | 0.99x |
| stat-loop | 1.00 | 1.13 | 0.99 | 0.95 | 1.04x | 0.88x |
| fork-exec-50 | 1.86 | 1.59 | 1.84 | 1.47 | 1.26x | 1.17x |

All outputs are identical with and without the JIT, and a lockstep boot shows
no mismatches. Worker CPU over the suite: ~15 s off-thread for 48k regions.

Where the remaining time goes / next steps:

* Short regions: CPython/V8 handlers are ~10-20 instructions ending in
  `jalr`, so the entry register loads and exit flushes dominate. Needs larger
  regions (multi-page, call/return inlining) or cross-region register state.
* FP runs through `jit_step` (node-f64-loop gains only 1.1x): Phase 6.
* npm translates fresh V8-generated code in every process: a persistent
  cache (Phase 5) only helps the node binary/kernel parts. Also measure
  thrash control on V8 code pages.
* `stat-loop` (syscall-heavy) is at parity: kernel entry/exit flushes the
  TinyEMU TLB and the jump cache (~800k jump-cache flushes over the suite).
  The plan's tagged TLB (Phase 1 prerequisite) is still open.

## Profiling round: tagged TLB, `time` CSR, coalescing (build `agentvm-jit11`)

**Where guest instructions run** (exit profiler, `AGENTVM_JIT_V2_PROFILE=1`,
which also writes the hottest regions to `<out>.top` and their pages to
`/tmp/jit-hot-*.bin`): 91% of guest instructions run inside regions for
python-int-loop, 79% for npm, 75% for node-int-loop, 66% for fork-exec
(boot included). Region calls average 20-25 instructions. Exits to the
interpreter are ~2% of calls. Further gains therefore have to come from
region code and per-call overhead, not from translating more.

**Where host time goes** (`node --prof`; region functions are named
`jit_<entry offset>` through a wasm name section; emulator functions can be
mapped through the export table, `wasm-function[678]` is the interpreter
loop): before this round, about 9% of all ticks in python-int-loop were
read-TLB misses from region code (`jit_load_helper` → `target_read_slow` →
`get_phys_addr`). TinyEMU's TLB had 256 direct-mapped entries per kind.

Changes (C, `tinyemu-jit-v2-core.patch`; they benefit the interpreter too):

* **Tagged TLB.** Entries store `page ^ tag`. The tag holds the translation
  context in bits 3..6 (data: effective privilege incl. MPRV/MPP, SUM in
  S-mode, MXR; code: privilege) and a 5-bit flush epoch in bits 7..11.
  Privilege, SUM, MXR and MPRV changes no longer flush any TLB. They no
  longer flush the JIT jump cache either, since they don't affect
  instruction fetch. A full flush (`satp`, `sfence.vma`) bumps the epoch and
  clears the arrays only every 31st time. The largest key is 0xfef, so a
  lookup can never equal the empty marker -1. Exports: `jit_tlb_tag_ptr`,
  `jit_tlb_size`; regions load the data tag once at entry.
* **TLB size 256 → 1024.** 4096 entries cut the miss path by ~75% but made
  region and interpreter code slower overall: the 196 KB of TLB arrays fell
  out of the host caches. 1024 entries (48 KB) keep most of the miss
  reduction (~1040 → ~280 ticks) and lower region ticks by ~10%.
* **`time` CSR** read directly from the RTC (`riscv_cpu_set_time_source`;
  same value as CLINT mtime, `mcounteren`/`scounteren` honored). Before,
  every `rdtime` (vDSO `clock_gettime`, kernel timekeeping) trapped into
  M-mode for BBL to emulate. Checked with `sleep`, Python `time.sleep` and
  `monotonic`, and Node timers.

JIT:

* **Same-page coalescing** (plan Phase 4, `AGENTVM_JIT_V2_COALESCE=0`
  disables). Runs of loads or of stores in one block through the same base
  register (not written in between) do one check: page range, base
  alignment, TLB entry. Each member then accesses memory directly, with a
  per-access fallback. It covers 44% of the memory instructions in the hot
  CPython regions. A differential fuzz test against `riscv-ref` (300 random
  programs around a page boundary, misaligned offsets, base updates) is in
  `test/jit-v2.test.js`. Measured gain: none beyond noise.

Results: profile ticks for python-int-loop are down ~11% (build 9 → 11).
Wall time is within the run-to-run noise (±5-15% on this laptop) for most
workloads: JIT npm 1.20x, python-heavy-imports 1.12x, the rest ±5%;
interpreter neutral.

Notes:

* Wall-clock benchmarking on this machine (i7-7700HQ laptop) varies up to
  ±15% between runs, even for the interpreter. Use `--repeat` with
  interleaved configurations, and prefer `node --prof` tick counts for
  small effects.
* One benchmark run died at startup with no output (stderr discarded); it did
  not reproduce in 12 retries. Keep stderr when benchmarking.
* The legacy loop JIT (`AGENTVM_JIT=1`) assumes untagged 256-entry TLBs.
  With these images its TLB probes always miss, which is correct but slow.

## Hardening round: tests, G1a, V8 tiers (build `agentvm-jit16`)

C changes:

* **Old loop JIT removed** (`jit_map`, `jit_hits`, `jit_try_block`, 9 MB of
  static tables plus a probe at every block boundary). `AGENTVM_JIT=1` now
  prints a hint. The old patches stay in the stack for their accessor exports.
* **Single-step copy of the interpreter.** The template is instantiated a
  second time (`JIT_STEP_VARIANT` → `riscv_cpu_step_x64`) for `jit_step`, as
  the plan proposed. The interpreter proper no longer checks
  `jit_single_step` after every instruction: **7-18% faster interpreter**
  (JIT on or off).
* **Probe only loop back-edges** on same-page taken branches.
* **Request backoff** per PC (threshold crossings 1, 2, 4, 8, ...): 8.9M →
  218k calls into JS when nothing installs. Physical-map lookups still happen
  every crossing, so installs are found promptly.
* **Negative jump-cache entries** (`table_idx == 0`, valid until the next
  install) skip vPC→pPC resolution at block boundaries for PCs without a
  region. The chain runtime treats them as misses.
* **No statistics on the per-branch probe** unless diagnostics are on.
* **Watching a page drops only the write-TLB entries for that page**, instead
  of the whole write TLB.
* `jit_set_hot_threshold` export (`AGENTVM_JIT_V2_HOT_THRESHOLD`).

JS:

* **Thrash control** (plan §4.5): more than 8 invalidations of a page within
  1 s → no requests for it for a doubling cool-down (1 s … 64 s).
  `thrashSkips`/`thrashCooldowns` in the host stats.
* Numeric page keys in `request()`.
* `AGENTVM_JIT_V2_DRYRUN=1` (probe and request, never install) for G1a.
* `AGENTVM_WASM` overrides the default image path (lets the repository's
  VM tests run against a JIT image).

**Gate G1a** (JIT on, nothing installed, vs JIT off): 0-8% for loops, 7-14%
for startup/kernel-heavy workloads. Still above the 3% target. The rest is
block-boundary dispatch and hotness counting. Note the noise level (±8%) when
reading this.

**Correctness suites** (build 16):

* CPython regression tests, 30 modules (`test_int`, `test_long`,
  `test_float`, `test_math`, `test_json`, `test_re`, `test_dict`,
  `test_unicode`, `test_struct`, ...): all pass under the JIT except two
  `test_re` locale tests, which fail identically with the interpreter (musl
  locales). The test image now includes `python3-tests`.
* Repository VM tests with `AGENTVM_WASM` + `AGENTVM_JIT_V2=1`: `basic`,
  `mount`, `symlink`, `framebuffer`, `framebuffer-delta` pass. `chmod-9p`,
  `pi-jiti-shim` and `audio` fail identically with the JIT off; the minimal
  test image lacks git, pi/jiti and alsa-utils.
* `riscv-tests` (rv64ui/um/ua/uc/uf/ud, 110 tests) built for Linux user mode
  with a custom environment header, run three times with hot threshold 1:
  107/110 pass in the interpreter, the JIT and JIT+lockstep, with identical
  failures and no lockstep mismatches. `rv64ua-lrsc`, `rv64ud-move` and
  `rv64ud-recoding` fail in TinyEMU itself; all 110 pass under QEMU. These
  are emulator bugs to look at separately. The self-modifying `rvc`/`fence_i`
  tests pass, which also exercises invalidation.

**V8 tiers and npm** (plan open question 1). Under the region JIT, short Node
processes are slowed by V8-generated code: every process produces fresh code
that has to be translated again. V8 tier flags were measured twice, with very
different results.

Before the warm snapshot (build 16, region JIT on, seconds first/warm):

| node flags | npm --version | node -e 0 | 1M-iteration loop |
|---|---|---|---|
| (default) | 14.5 / 6.3 | 0.85 / 0.80 | 1.11 / 0.89 |
| `--jitless` | 6.9 / 5.5 | 0.93 / 0.82 | 1.73 / 1.73 |
| `--no-sparkplug` | 6.8 / 6.1 | 0.86 / 0.84 | 0.93 / 0.93 |

That suggested `--no-sparkplug` as a win. **On the released image (0.5.0,
warm snapshot) the same flags are a clear loss** — the first run's cost was
mostly cold I/O, and once the page cache is warm, Sparkplug's baseline code
(translated once by the region JIT) beats leaving functions in Ignition.
Fresh VM per row, two rounds, seconds (first/warm):

| node flags | npm --version (JIT on) | node -e 0 (JIT on) | loop (JIT on) | npm (JIT off) |
|---|---|---|---|---|
| (default) | 8.0-11.2 / 6.0-8.4 | 0.83-1.00 / 0.77-0.88 | 0.95 / 0.92 | 6.9-7.4 / 6.2-6.8 |
| `--no-sparkplug` | 9.4-11.8 / 6.9-7.5 | 0.92-0.93 / 0.88 | 0.98-1.01 / 1.01 | 7.8-8.3 / 7.2-7.4 |
| `--always-sparkplug` | 14.6-15.3 / 8.7-10.7 | 1.04-1.20 / 0.95-1.18 | 1.08-1.27 / 1.04-1.31 | — |
| `--no-maglev` | 10.8-14.3 / 8.5-10.3 | 0.92-0.94 / 0.89-1.02 | 0.95-2.07 / 1.67-2.07 | — |
| `--max-opt=1` | 13.2-13.5 / 7.1-8.0 | 0.96-0.98 / 0.93-1.26 | 1.46-1.49 / 1.50-1.92 | — |

`pi --version` is affected the same way: 19.5 s / 15.8 s (JIT on) with the
default wrapper, 29.8 s / 16.5 s with `--no-sparkplug`.

So the guest Node keeps its default tiering; no flag is added to the image's
`/usr/local/bin/node` wrapper (which carries `--single-threaded-gc` only).
Node rejects `--no-sparkplug` in `NODE_OPTIONS`, so if a workload ever needs
it, it must be passed on the command line or via a wrapper.

Final numbers, build 16, JIT vs interpreter (best of 3): python-int-loop
3.5x, node-startup 1.9x, python-startup 1.36x, fork-exec 1.35x, npm 1.12x.

## Tests

```bash
node test/jit-v2.test.js      # translator correctness, no VM image
node test/bench-jit.js --insn # guest wall time + retired instructions
```

The translator tests compare against `src/riscv-ref.js` (now including RV64M)
and cover: ALU/M/W forms, branches, in-region loops, budget exits, JALR,
inline-TLB loads/stores, precise load/store bail, generation invalidation,
compressed instructions, compiler keys, and the sampler/trace rings.

## Next steps

1. **Phase 3:** exit slots + `return_call_indirect` chaining, `rt_dispatch`
   runtime module, compiler worker with batching and generation-checked
   install, epoch flush and thrash cool-down.
2. **Phase 2 fallback (partly done):** FP/AMO already use `jit_step`; add
   CSR reads (`rdtime`/`rdcycle`/`rdinstret`) with exact `insn_counter`
   flushing.
3. **Phase 4:** same-page TLB coalescing, `lui`/`auipc` folding, dead-write
   elimination, larger multi-page regions.
4. **Phase 5:** persist real modules (not just scaffolding) and generate the
   prebuilt pack in `image/build.sh`.

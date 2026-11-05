# Changelog

## 0.5.0

Faster VM: a new region JIT (opt-in), a much faster interpreter, and a
snapshot whose guest caches are already warm.

### Performance

- **Region JIT (experimental, `AGENTVM_JIT_V2=1`).** Hot guest code is
  translated to WebAssembly in a background compiler worker: page-confined
  region CFGs, inline TLB loads/stores with slow-path helpers, batched
  installs with pre-compiled modules, and a single-step interpreter fallback
  for FP, AMO and CSR reads. On the shipped image: CPU-bound Python 2.9x,
  `node` startup 2.0x, `node` int loop 1.5x, `npm --version` 1.2x (warm).
  On `pi --version` the JIT now takes 18.7s against 23.4s interpreted, and
  `npm --version` is at parity for its first run. Off by default.
- **Faster interpreter** (with or without the JIT): the single-step copy of
  the CPU loop is a separate instantiation, so the interpreter no longer
  checks a single-step flag after every instruction (7-18%); the TLBs are
  tagged with their translation context and flushed by epoch instead of on
  every privilege or SUM/MXR change, and are 4x larger; the `time` CSR reads
  the RTC directly instead of trapping into M-mode.
- **Warm snapshot.** Before the Wizer snapshot, the build runs python3, node,
  npm, git and pi once against the container image, so the page and dentry
  caches are part of the snapshot. Cold first runs in a fresh VM:
  `python3 -c pass` 3.3s -> 0.65s, `node -e 0` 5.7s -> 1.7s, python heavy
  imports 8.4s -> 6.1s, `npm --version` 11.5s -> 7.4s. Disable with
  `WARMUP=0`, override the commands with `WARMUP_CMDS`.
- The image grows accordingly (482 MB vs 374 MB).

### Fixes

- `riscv-c`: the compressed load/store immediates for `C.LD`, `C.SD`,
  `C.LWSP`, `C.LDSP`, `C.SWSP` and `C.SDSP` were permuted (about 9k
  encodings, e.g. `c.sdsp s0, 32(sp)` stored to `sp+256`). Also reject the
  reserved `C.ADDI16SP imm=0` / `C.LWSP`/`C.LDSP rd=x0` encodings.
- The old loop JIT (`AGENTVM_JIT=1`) is gone from the emulator; the flag now
  prints a hint to use `AGENTVM_JIT_V2=1`.

### Other

- `AGENTVM_WASM` overrides the default image path.
- New test and benchmark harnesses: `npm run test:jit`, `npm run bench:jit`,
  lockstep verifier (`AGENTVM_JIT_V2_VERIFY=1`), exit profiler
  (`AGENTVM_JIT_V2_PROFILE=1`), and `test/riscv-tests/` (the official ISA
  suites, run inside the VM).
- The shipped image updates Alpine (3.21.9), Node (22.23.4) and Python
  (3.12.16); pi stays at 0.85.1.

## 0.4.0

See the git history and README for earlier changes.

# Testing the TinyEMU acceleration branch

This branch (`perf/tinyemu-jit`) contains two independent performance tiers on
top of `feature/hax-agent`:

- **Tier 1 — paravirtual bulk memory (`PV_ACCEL`, on by default).** TinyEMU
  decodes a custom-0 hypercall and the guest kernel routes `clear_page`/
  `copy_page` through it. Shipped and measured at **1.05–1.14×** on Node/Python
  startup and allocation workloads.
- **Tier 2 — in-WASM RISC-V trace JIT (`AGENTVM_JIT=1`, opt-in).** TinyEMU
  exports its indirect function table and calls compiled traces with
  `call_indirect`; the host only installs traces. Measured **~15×** on
  call-free ALU loops, **~6×** on loops with a small leaf call, and at
  **parity** on the current Node/Python microbenchmarks.

The image also enables **transparent huge pages** and pre-populates V8's
**compile cache for the pi bundle** (1.34× on `pi --version`).

## Build

```bash
# pi + hax image (the repo's default artifact)
PV_ACCEL=1 image/build-pi.sh /tmp/agentvm-alpine-python.wasm

# unaccelerated Tier-1 baseline for A/B
PV_ACCEL=0 image/build.sh /tmp/agentvm-baseline.wasm
```

Requires Docker + buildx, riscv64 binfmt, and `c2w`. The kernel and TinyEMU
stages cache, so a rebuild after host/runtime changes is a few minutes.

## Unit tests (no image needed)

```bash
node test/jit-spike.test.js
node test/jit-external.test.js
node test/jit-loop.test.js
node test/jit-direct.test.js
node test/jit-alu.test.js
node test/jit-selfloop.test.js
node test/jit-inline.test.js
node test/riscv-c.test.js
```

These cover the translator, precise bail, compressed decoding, register
locals, self-loops and call inlining. `data-integrity.test.js`, `basic.test.js`
and `mount.test.js` boot the VM and should keep passing.

## Integration

```bash
# default (Tier 1 only)
node test/bench-one.js ./agentvm-alpine-python.wasm 3

# enable the JIT
AGENTVM_JIT=1 node test/bench-one.js ./agentvm-alpine-python.wasm 3
AGENTVM_JIT=1 node test/bench-jit-vm.js ./agentvm-alpine-python.wasm 3
```

Expected with the JIT on (acceptance image, JIT off → on):

| workload | JIT off | JIT on |
|---|---:|---:|
| boot | ~1.6 s | ~1.6–1.8 s |
| call-free ALU loop (50 M) | ~2.8 s | ~0.19 s |
| loop calling a 1-instruction leaf (5 M) | ~0.18 s | ~0.03 s |
| Node integer / string loops | ~2.5 s | ~0.95–1.05× |
| `python3 sum(range())` | — | ~0.95–1.05× |

Correctness: Node/Python/`intloop` outputs must be identical with the JIT on
and off.

## Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `AGENTVM_JIT` | off | enable the JIT |
| `AGENTVM_JIT_NO_C` | off | disable compressed-instruction translation (debug) |
| `AGENTVM_JIT_NO_INLINE` | off | disable leaf call inlining |
| `AGENTVM_JIT_INLINE_MAX` | 6 | max instructions in an inlined leaf callee |
| `AGENTVM_JIT_LOOP_BUDGET` | 64 | loop iterations per host call |
| `AGENTVM_JIT_ALL_BLOCKS` | off | compile non-loop blocks too (slow) |
| `AGENTVM_JIT_MIN_BLOCK` | 0 | minimum length for a non-loop trace |
| `AGENTVM_JIT_PC_MIN` / `_MAX` | 0 / 0x4000000000 | restrict translated guest PCs |
| `DEBUG_JIT` | off | log trace installs/errors |

## Known limitations

- The JIT accelerates **loops without calls or with small straight-line leaf
  calls**. CPython's `ceval` switch and V8's dynamically JIT-compiled code are
  not traced yet, which is why Node/Python sit at parity rather than faster.
- Non-loop blocks are not compiled by default: the per-block host dispatch
  dominates short blocks.
- `--jitless` plus AOT of the static Node binary is the identified path to
  cover V8's own code; see `docs/tinyemu-acceleration-strategy.md`.
- The accelerated guest image requires the `tinyemu-jit-table.patch` build
  (exported table); the worker provides a `jit_try_block` no-op so older images
  still boot with the JIT disabled.

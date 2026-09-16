# AgentVM 0.2 image

Build-time assets for the acceptance image: **riscv64 Alpine + Python + Node/npm**.

The shipped artifact is a single portable `.wasm` (plus the runtime's
`manifest` if we add one). The Node runtime never needs Docker, `c2w`, a
cross-toolchain or binfmt.

## Prerequisites (build machine only)

- Docker with buildx
- riscv64 binfmt emulation:
  `docker run --privileged --rm tonistiigi/binfmt --install riscv64`
- container2wasm `c2w` converter (supports `--dockerfile` and `--extra-flag`)

## Build

```bash
cd image
C2W=/path/to/c2w ./build.sh [out.wasm]
```

This produces `agentvm-alpine-python-node.wasm` (roughly 193 MB with the
current acceptance root filesystem). To keep a baseline image while testing a
new build, pass another output name:

```bash
C2W=/path/to/c2w ./build.sh agentvm-alpine-python-node-optimized.wasm
```

### Preinstalled pi variant

`build-pi.sh` produces `agentvm-alpine-python-node-pi.wasm`, which has the
`pi` coding agent preinstalled so runtime `npm install -g` is not needed.
`preinstall-pi.sh` generates `preinstalled/usrlocal` by running the real npm
install inside a working AgentVM.

The pi image also wraps both `pi` and `node` with `--single-threaded-gc`.
V8's concurrent GC threads contend with the interpreter on the emulated
single hart; disabling concurrent GC roughly halves guest Node CPU time.

## Low-risk runtime optimizations

The build applies the compatibility patch plus
`patches/tinyemu-low-risk-performance.patch` and
`patches/tinyemu-fast-branch.patch`. Together they:

- builds the TinyEMU WASI interpreter with `-O3` instead of `-O2`,
- enables link-time optimization,
- removes the unused RV32 decoder (RV64-only), and the linked emulator is
  stripped,
- builds the guest Linux kernel for performance (`-O2`) instead of size (`-Os`), and
- avoids redundant code-TLB lookups for ordinary same-page branches while
  preserving the slow path at timer, interrupt, privilege, and page boundaries,
- and runs Binaryen `wasm-opt -O3` over the linked TinyEMU module before
  Wizer snapshots it.

## Paravirtual bulk-memory acceleration (PV_ACCEL)

The build also applies `patches/tinyemu-pv-accel.patch` and
`patches/linux-riscv-pv-accel.patch` by default (`PV_ACCEL=1`):

- TinyEMU decodes a custom-0 instruction (`funct7 = 0x70`) as a hypercall that
  performs bulk `memset`/`memcpy` on guest RAM directly.
- The guest kernel (`CONFIG_RISCV_PV_ACCEL`) routes `clear_page`/`copy_page`
  through it, so anonymous-page faults and `fork`/COW no longer interpret
  hundreds of guest stores per page. If the emulator cannot service a range it
  returns a status and the kernel runs the normal software routine.

Build the unaccelerated baseline for A/B measurement with:

```bash
PV_ACCEL=0 ./build.sh /tmp/agentvm-baseline.wasm
```

The image also disables verbose init and kernel logging. The c2w recipe already
disables TinyEMU's unused SDL, x86, RV128, SLIRP, and network-filesystem
features, and uses Wizer; the build preserves those settings.

A three-run local comparison using Node 22 showed median improvements of about
9% for boot, 6–8% for a guest Node CPU loop, and 10% for a 1,000-small-file
workload. The same-page branch fast path contributes roughly another 1–2% to
CPU-heavy Node code, and the RV64-only decoder contributes a similar small
filesystem/CPU improvement. Increasing TinyEMU's instruction batch size was
also benchmarked and rejected after it caused a large Node/V8 regression.
These are deliberately conservative changes; npm remains
dominated by interpreted RISC-V execution and guest filesystem metadata
operations.

## Why we patch TinyEMU

Alpine's riscv64 `node` binary is built for `rv64gc` but contains the newer
`fence.tso` instruction (Ztso), which the pinned 2019 TinyEMU rejects as
illegal, making `node` crash with `SIGILL` right after printing its version.

`patches/tinyemu-fence-tso.patch` accepts `fence.tso` as a no-op, which is
correct on a single in-order emulated hart (there is no observable memory
reordering to fence). `build.sh` applies it automatically and injects the
patched source as a build context into the embedded c2w Dockerfile.

## Acceptance test

```bash
node test/acceptance.test.js image/agentvm-alpine-python-node.wasm
```

This boots the image and, inside the VM:

1. checks `python3`/`pip`/`node`/`npm` versions,
2. `pip install cowsay`,
3. `npm install is-number`,
4. `npm install -g @earendil-works/pi-coding-agent`,
5. runs `pi --help`.

Set `AGENTVM_SKIP_PI=1` to skip the large pi install while iterating.

## Startup shaping (measured experiments)

Two Node-startup experiments were run against the pi-relevant workloads:

### 1. V8 compile cache for the pi bundle (shipped)

The pi agent is a 7.6 MB **ESM** bundle. Bytenode does not support ESM, but
Node 22's `NODE_COMPILE_CACHE` does. `Dockerfile.pi` pre-populates the cache at
build time and points the image env at it. Measured on the pi image:
`pi --version` **31931 ms → 23861 ms (1.34×)**; the cache is 1.8 MB.

### 2. Slim Node without ICU (optional, not shipped)

Alpine's `nodejs` links system ICU; ICU initialization is ~15% of `node`
startup under emulation (removing the ICU data gave 1840 → 1573 ms). A
`--with-intl=none` Node needs a from-source musl build:

```bash
image/build-slim-node.sh          # -> image/slimnode/node (well over an hour)
```

Then `COPY --link slimnode/node /usr/local/bin/node` into the guest image and
keep Alpine's `nodejs` only for `npm`. This is deliberately not part of the
default build: the emulated compile is very long, and the ~15% is on generic
startup only (negligible next to the pi bundle's parse time, which the compile
cache addresses).

Negative results from the same sweep, for the record: `vmtouch`/page-cache
pre-warm, read-ahead/vfs sysctls (read-only), and a 9p `msize` bump (stock
TinyEMU's 9p layer hangs on 256 KiB messages) did **not** help. Transparent
huge pages, however, are a large win for guest memory and are enabled in
`build.sh`.

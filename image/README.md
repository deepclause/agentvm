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

## Low-risk runtime optimizations

The build applies the compatibility patch plus
`patches/tinyemu-low-risk-performance.patch` and
`patches/tinyemu-fast-branch.patch`. Together they:

- builds the TinyEMU WASI interpreter with `-O3` instead of `-O2`,
- enables link-time optimization,
- removes debug information and strips the linked emulator,
- builds the guest Linux kernel for performance (`-O2`) instead of size (`-Os`), and
- avoids redundant code-TLB lookups for ordinary same-page branches while
  preserving the slow path at timer, interrupt, privilege, and page boundaries.

The image also disables verbose init and kernel logging. The c2w recipe already
disables TinyEMU's unused SDL, x86, RV128, SLIRP, and network-filesystem
features, and uses Wizer; the build preserves those settings.

A three-run local comparison using Node 22 showed median improvements of about
9% for boot, 6–8% for a guest Node CPU loop, and 10% for a 1,000-small-file
workload. The same-page branch fast path contributes roughly another 1–2% to
CPU-heavy Node code. Increasing TinyEMU's instruction batch size was also
benchmarked and rejected after it caused a large Node/V8 regression. These are
deliberately conservative changes; npm remains
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

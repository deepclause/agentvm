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

This produces `agentvm-alpine-python-node.wasm` (roughly 175 MB).

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

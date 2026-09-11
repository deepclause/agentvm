#!/usr/bin/env bash
# Build the AgentVM 0.2 acceptance image (riscv64 Alpine + Python + Node/npm).
#
# Build-time only. Requires:
#   - Docker with buildx and riscv64 binfmt emulation
#     (e.g. `docker run --privileged --rm tonistiigi/binfmt --install riscv64`)
#   - the container2wasm `c2w` converter (supports --dockerfile/--extra-flag)
#
# The runtime never runs this script; it only consumes the produced .wasm.
#
# Usage:
#   C2W=/path/to/c2w ./build.sh [output.wasm]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/agentvm-alpine-python-node.wasm}"
IMAGE_NAME="agentvm-alpine-python-node:riscv64"
C2W="${C2W:-c2w}"
# Guest RAM. The writable overlay (and /run tmpfs) default to ~half of this,
# so the pi coding agent needs substantially more than the 128 MiB default.
VM_MEMORY_SIZE_MB="${VM_MEMORY_SIZE_MB:-1024}"

# TinyEMU pinned by the embedded c2w Dockerfile. We patch it to accept the
# `fence.tso` instruction that modern riscv64 node/npm binaries emit.
TINYEMU_REPO="${TINYEMU_REPO:-https://github.com/ktock/tinyemu-c2w}"
TINYEMU_REV="${TINYEMU_REV:-e4e9bd198f9c0505ab4c77a6a9d038059cd1474a}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Building riscv64 source image: $IMAGE_NAME"
docker buildx build \
    --platform linux/riscv64 \
    -t "$IMAGE_NAME" \
    -f "$HERE/Dockerfile.acceptance" \
    --load \
    "$HERE"

echo "==> Preparing patched TinyEMU"
git clone -q "$TINYEMU_REPO" "$WORK/tinyemu"
git -C "$WORK/tinyemu" checkout -q "$TINYEMU_REV"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-fence-tso.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-low-risk-performance.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-rv64-only.patch"
# Generated without context to avoid preserving upstream trailing whitespace.
git -C "$WORK/tinyemu" apply --unidiff-zero "$HERE/patches/tinyemu-fast-branch.patch"
rm -rf "$WORK/tinyemu/.git"

echo "==> Generating patched c2w Dockerfile"
"$C2W" --show-dockerfile > "$WORK/Dockerfile.c2w"
python3 - "$WORK/Dockerfile.c2w" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """FROM ubuntu:22.04 AS tinyemu-repo-base
ARG TINYEMU_REPO
ARG TINYEMU_REPO_VERSION
RUN apt-get update && apt-get install -y git
RUN git clone ${TINYEMU_REPO} /tinyemu && \\
    cd /tinyemu && \\
    git checkout ${TINYEMU_REPO_VERSION}
FROM scratch AS tinyemu-repo
COPY --link --from=tinyemu-repo-base /tinyemu /
"""
new = """FROM scratch AS tinyemu-repo
COPY --from=tinyemu-patched / /
"""
assert s.count(old) == 1, "unexpected embedded Dockerfile shape"
s = s.replace(old, new)

# The stock c2w kernel is optimized for size (-Os). npm and Node spend a lot
# of time in guest syscalls and filesystem/network paths, so use the kernel's
# normal performance profile (-O2). Apply this to both riscv64 kernel stages.
config_copy = "COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n"
config_tune = config_copy + "RUN scripts/config --disable CC_OPTIMIZE_FOR_SIZE --enable CC_OPTIMIZE_FOR_PERFORMANCE\n"
assert s.count(config_copy) == 2, "unexpected riscv64 kernel config stages"
s = s.replace(config_copy, config_tune)

# The target is always riscv64. The stock recipe links a separate RV32 CPU and
# also compiles the 32-bit decoder into the RV64 object. The source patch
# removes that decoder; specialize the one remaining object at compile time.
old_objects = "riscv_machine.o softfp.o riscv_cpu32.o riscv_cpu64.o fs_disk.o"
new_objects = "riscv_machine.o softfp.o riscv_cpu64.o fs_disk.o"
assert s.count(old_objects) == 1, "unexpected TinyEMU object list"
s = s.replace(old_objects, new_objects)
old_cc = "-D_WASI_EMULATED_SIGNAL -DWASI -I/tools/wizer/include/"
new_cc = "-D_WASI_EMULATED_SIGNAL -DWASI -DCONFIG_RISCV_ONLY_64 -I/tools/wizer/include/"
assert s.count(old_cc) == 1, "unexpected TinyEMU compiler command"
s = s.replace(old_cc, new_cc)
open(p, "w").write(s)
PY

echo "==> Converting to WASM: $OUT (memory ${VM_MEMORY_SIZE_MB} MiB)"
"$C2W" --target-arch riscv64 \
    --build-arg "VM_MEMORY_SIZE_MB=${VM_MEMORY_SIZE_MB}" \
    --build-arg "LINUX_LOGLEVEL=3" \
    --build-arg "INIT_DEBUG=false" \
    --dockerfile "$WORK/Dockerfile.c2w" \
    --extra-flag "--build-context=tinyemu-patched=$WORK/tinyemu" \
    "$IMAGE_NAME" \
    "$OUT"

echo "==> Done: $OUT"
ls -lh "$OUT"

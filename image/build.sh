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
open(p, "w").write(s.replace(old, new))
PY

echo "==> Converting to WASM: $OUT (memory ${VM_MEMORY_SIZE_MB} MiB)"
"$C2W" --target-arch riscv64 \
    --build-arg "VM_MEMORY_SIZE_MB=${VM_MEMORY_SIZE_MB}" \
    --dockerfile "$WORK/Dockerfile.c2w" \
    --extra-flag "--build-context=tinyemu-patched=$WORK/tinyemu" \
    "$IMAGE_NAME" \
    "$OUT"

echo "==> Done: $OUT"
ls -lh "$OUT"

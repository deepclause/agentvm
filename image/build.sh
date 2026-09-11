#!/usr/bin/env bash
# Build the AgentVM 0.2 acceptance image (riscv64 Alpine + Python + Node/npm).
#
# Build-time only. Requires Docker with buildx (for linux/riscv64) and the
# container2wasm `c2w` converter. The runtime never runs this script.
#
# Usage:
#   C2W=/path/to/c2w ./build.sh [output.wasm]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/agentvm-alpine-python-node.wasm}"
IMAGE_NAME="agentvm-alpine-python-node:riscv64"
C2W="${C2W:-c2w}"

echo "==> Building riscv64 source image: $IMAGE_NAME"
docker buildx build \
    --platform linux/riscv64 \
    -t "$IMAGE_NAME" \
    -f "$HERE/Dockerfile.acceptance" \
    --load \
    "$HERE"

echo "==> Converting to WASM: $OUT"
"$C2W" --target-arch riscv64 "$IMAGE_NAME" "$OUT"

echo "==> Done: $OUT"
ls -lh "$OUT"

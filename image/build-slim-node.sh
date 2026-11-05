#!/usr/bin/env bash
# Build the optional no-ICU Node for Alpine/musl riscv64 (see Dockerfile.slimnode).
# Requires riscv64 binfmt. This takes well over an hour under emulation.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker buildx build --platform linux/riscv64 \
    -f "$HERE/Dockerfile.slimnode" \
    -t node-slim:riscv64 \
    --output "type=local,dest=$HERE/slimnode" \
    "$HERE"
ls -la "$HERE/slimnode/node"

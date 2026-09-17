#!/usr/bin/env bash
# Cross-compile the framebuffer demos for the guest (static riscv64). Static so
# they run on Alpine/musl without a dynamic loader.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="${CC:-riscv64-linux-gnu-gcc}"
for src in "$HERE"/*.c; do
    out="${src%.c}"
    "$CC" -O2 -static -o "$out" "$src"
    echo "built $out"
done

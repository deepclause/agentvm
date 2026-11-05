#!/usr/bin/env bash
# Build the riscv-tests ISA suites (rv64ui/um/ua/uc/uf/ud) as static Linux
# user-mode binaries, using riscv_test.h in this directory as the test
# environment (pass/fail = exit syscall). Runs natively in a riscv64 Alpine
# container (Docker binfmt/QEMU) and also runs the binaries there as a
# sanity check.
#
# Usage: test/riscv-tests/build.sh [outdir]   (default: /tmp/riscv-tests-out)
# Extra docker flags (e.g. IPv4 host mappings): RVT_DOCKER_FLAGS="--add-host=..."
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/riscv-tests-out}"
mkdir -p "$OUT"
# shellcheck disable=SC2086
docker run --rm --platform linux/riscv64 ${RVT_DOCKER_FLAGS:-} \
    -v "$HERE":/env:ro -v "$OUT":/out alpine:3.21 sh -c '
set -e
apk add --no-cache build-base git >/dev/null
cd /tmp && git clone -q --depth 1 https://github.com/riscv-software-src/riscv-tests.git
rm -rf /out/*
for suite in rv64ui rv64um rv64ua rv64uc rv64uf rv64ud; do
  for src in riscv-tests/isa/$suite/*.S; do
    name=$(basename $src .S)
    # Self-modifying tests need a writable text segment. Everything else
    # keeps text read-only, so pages stay shared between runs and the region
    # JIT can reuse translations.
    case "$name" in rvc|fence_i) LDX=-Wl,-N;; *) LDX=;; esac
    gcc -march=rv64gc -mabi=lp64d -static -nostdlib -nostartfiles $LDX \
        -I/env -I riscv-tests/isa/macros/scalar -o /out/$suite-$name $src
  done
done
cd /out; pass=0; fail=""
for t in *; do if ./$t >/dev/null 2>&1; then pass=$((pass+1)); else fail="$fail $t"; fi; done
echo "native (qemu-user): pass=$pass failed:$fail"
chmod -R a+rwX /out
'

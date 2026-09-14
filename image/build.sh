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
DOCKERFILE="${DOCKERFILE:-Dockerfile.acceptance}"
IMAGE_NAME="${IMAGE_NAME:-agentvm-alpine-python-node:riscv64}"
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
    -f "$HERE/$DOCKERFILE" \
    --load \
    "$HERE"

echo "==> Preparing patched TinyEMU"
git clone -q "$TINYEMU_REPO" "$WORK/tinyemu"
git -C "$WORK/tinyemu" checkout -q "$TINYEMU_REV"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-fence-tso.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-low-risk-performance.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-rv64-only.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-exports.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-hook.patch"
# Generated without context to avoid preserving upstream trailing whitespace.
git -C "$WORK/tinyemu" apply --unidiff-zero "$HERE/patches/tinyemu-fast-branch.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-writable-second-drive.patch"
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

# Allow block devices in the container spec so a second virtio drive can be
# used as a non-9p overlay upperdir (device cgroup otherwise returns EPERM).
old_assets_clone = "RUN git clone -b ${SOURCE_REPO_VERSION} ${SOURCE_REPO} /assets"
new_assets_clone = old_assets_clone + (
    "\nRUN sed -i 's/ctdoci.WithNewPrivileges, \\/\\/ TODO: make it configurable/ctdoci.WithNewPrivileges, \\/\\/ TODO: make it configurable\\n\\t\\tctdoci.WithAllDevicesAllowed,/' /assets/cmd/create-spec/main.go"
    "\nRUN sed -i '/s.Linux.Seccomp = nil/ a\\\\tif s.Process.Capabilities != nil {\\n"
    "\\t\\ts.Process.Capabilities.Bounding = append(s.Process.Capabilities.Bounding, \"CAP_SYS_ADMIN\")\\n"
    "\\t\\ts.Process.Capabilities.Effective = append(s.Process.Capabilities.Effective, \"CAP_SYS_ADMIN\")\\n"
    "\\t\\ts.Process.Capabilities.Permitted = append(s.Process.Capabilities.Permitted, \"CAP_SYS_ADMIN\")\\n"
    "\\t\\ts.Process.Capabilities.Ambient = append(s.Process.Capabilities.Ambient, \"CAP_SYS_ADMIN\")\\n"
    "\\t}' /assets/cmd/create-spec/main.go"
)
assert s.count(old_assets_clone) == 1, "unexpected assets clone step"
s = s.replace(old_assets_clone, new_assets_clone)

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
new_cc = "-D_WASI_EMULATED_SIGNAL -DWASI -DCONFIG_RISCV_ONLY_64 -DCONFIG_JIT -I/tools/wizer/include/"
assert s.count(old_cc) == 1, "unexpected TinyEMU compiler command"
s = s.replace(old_cc, new_cc)

# Run Binaryen's optimizer over the linked TinyEMU module before Wizer
# snapshots it. This shrinks the emulator and can improve V8 tiering.
old_config_step = "RUN cat /tinyemu.config.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB envsubst > /out/tinyemu.config"
new_config_step = old_config_step + " && sed -i '$i\\    drive1: { file: \"/agentvm-persist/upper.img\" },' /out/tinyemu.config"
assert s.count(old_config_step) == 1, "unexpected tinyemu config step"
s = s.replace(old_config_step, new_config_step)

old_wizer = "RUN mv temu temu-org && /tools/wizer/wizer --allow-wasi --wasm-bulk-memory=true -r _start=wizer.resume --mapdir /pack::/pack -o temu temu-org"
new_wizer = (
    "RUN mkdir -p /agentvm-persist && truncate -s 512M /agentvm-persist/upper.img\n"
    "ARG BINARYEN_VERSION\n"
    "RUN wget -O /tmp/binaryen.tar.gz "
    "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/"
    "binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz && "
    "mkdir -p /binaryen && tar -C /binaryen -zxvf /tmp/binaryen.tar.gz && "
    "rm /tmp/binaryen.tar.gz\n"
    "RUN mv temu temu-org && "
    "/binaryen/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt temu-org -O3 --enable-bulk-memory -o temu-opt && "
    "mv temu-opt temu-org && "
    "/tools/wizer/wizer --allow-wasi --wasm-bulk-memory=true -r _start=wizer.resume "
    "--mapdir /pack::/pack --mapdir /agentvm-persist::/agentvm-persist -o temu temu-org"
)
assert s.count(old_wizer) == 1, "unexpected TinyEMU wizer stage"
s = s.replace(old_wizer, new_wizer)
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

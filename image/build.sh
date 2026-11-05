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
# Paravirtual bulk-memory acceleration (TinyEMU hypercall + guest kernel).
# Set PV_ACCEL=0 to build the unaccelerated baseline for A/B measurement.
PV_ACCEL="${PV_ACCEL:-1}"
# Guest RAM. The writable overlay (and /run tmpfs) default to ~half of this,
# so the pi coding agent needs substantially more than the 128 MiB default.
VM_MEMORY_SIZE_MB="${VM_MEMORY_SIZE_MB:-1024}"
# Optional virtual framebuffer: FRAMEBUFFER=1 exposes the guest /dev/fb0 via
# TinyEMU's simplefb device and exports the pixel buffer to the host (see
# docs/framebuffer-design.md). FRAMEBUFFER=0 (default) leaves the image as-is.
FRAMEBUFFER="${FRAMEBUFFER:-1}"
FB_WIDTH="${FB_WIDTH:-1024}"
FB_HEIGHT="${FB_HEIGHT:-768}"
# build.sh's config step reads these from the environment.
export FRAMEBUFFER FB_WIDTH FB_HEIGHT
# Optional virtio-snd playback (see docs/audio-design.md). AUDIO=1 adds a
# virtio sound device and enables the guest ALSA + SND_VIRTIO.
AUDIO="${AUDIO:-1}"
export AUDIO

# TinyEMU pinned by the embedded c2w Dockerfile. We patch it to accept the
# `fence.tso` instruction that modern riscv64 node/npm binaries emit.
TINYEMU_REPO="${TINYEMU_REPO:-https://github.com/ktock/tinyemu-c2w}"
TINYEMU_REV="${TINYEMU_REV:-e4e9bd198f9c0505ab4c77a6a9d038059cd1474a}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Keep the kernel patch in its own build context so that changing a TinyEMU
# patch does not invalidate the (expensive) kernel build stage.
mkdir -p "$WORK/kernel-patches"
if [ "$PV_ACCEL" = "1" ]; then
    cp "$HERE/patches/linux-riscv-pv-accel.patch" "$WORK/kernel-patches/"
fi

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
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-table.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-tlb.patch"
# Generated without context to avoid preserving upstream trailing whitespace.
git -C "$WORK/tinyemu" apply --unidiff-zero "$HERE/patches/tinyemu-fast-branch.patch"
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-writable-second-drive.patch"
# Accept (no-op) chmod on the 9p mount so tools (npm, git, ...) don't fail with
# EPROTO on /workspace.
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-9p-setattr-chmod.patch"
# Export the simplefb pixel buffer to the host (fb_ptr/width/height/stride).
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-framebuffer.patch"
# virtio-snd playback device.
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-virtio-snd.patch"
# Region-JIT infrastructure (jump cache, physical map, page generations,
# single-step helper, PC/trace samplers, deterministic RTC option).
git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-v2-core.patch"
if [ "$PV_ACCEL" = "1" ]; then
    git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-pv-accel.patch"
    # PV copy_page/clear_page write RAM directly; bump the JIT page
    # generations so self-modifying guest code is never executed stale.
    git -C "$WORK/tinyemu" apply "$HERE/patches/tinyemu-jit-v2-pv.patch"
fi
rm -rf "$WORK/tinyemu/.git"

echo "==> Generating patched c2w Dockerfile"
"$C2W" --show-dockerfile > "$WORK/Dockerfile.c2w"
python3 - "$WORK/Dockerfile.c2w" <<'PY'
import sys
import os
p = sys.argv[1]
s = open(p).read()
pv_accel = os.environ.get("PV_ACCEL", "1") == "1"
# Optional virtual framebuffer (simple-framebuffer -> /dev/fb0).
framebuffer = os.environ.get("FRAMEBUFFER", "0") == "1"
fb_w = os.environ.get("FB_WIDTH", "1024")
fb_h = os.environ.get("FB_HEIGHT", "768")
# Optional virtio-snd playback.
audio = os.environ.get("AUDIO", "0") == "1"
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
# When PV_ACCEL=1 we also patch the riscv64 kernel to route page clear/copy
# through the TinyEMU hypercall (see patches/linux-riscv-pv-accel.patch).
config_copy = "COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config\n"
# FB_SIMPLE binds the FDT simple-framebuffer node to /dev/fb0; INPUT_EVDEV
# exposes virtio-input as /dev/input/eventN.
fb_kernel_opts = " --enable FB_SIMPLE --enable INPUT_EVDEV" if framebuffer else ""
# SND_VIRTIO binds the virtio-snd device; SOUND/SND enable ALSA.
audio_kernel_opts = " --enable SOUND --enable SND --enable SND_VIRTIO" if audio else ""
config_tune = config_copy + (
    "RUN scripts/config --disable CC_OPTIMIZE_FOR_SIZE "
    "--enable CC_OPTIMIZE_FOR_PERFORMANCE --enable TRANSPARENT_HUGEPAGE --enable TRANSPARENT_HUGEPAGE_ALWAYS"
    + fb_kernel_opts
    + audio_kernel_opts
    + (" --enable RISCV_PV_ACCEL" if pv_accel else "")
    + "\n"
)
assert s.count(config_copy) == 2, "unexpected riscv64 kernel config stages"
s = s.replace(config_copy, config_tune)

if pv_accel:
    old_riscv_clone = (
        "FROM gcc-riscv64-linux-gnu-base AS linux-riscv64-dev-common\n"
        "RUN apt-get update && apt-get install -y gperf flex bison bc\n"
        "RUN mkdir /work-buildlinux\n"
        "WORKDIR /work-buildlinux\n"
        "RUN git clone -b v6.1 --depth 1 https://github.com/torvalds/linux\n"
    )
    new_riscv_clone = (
        "FROM gcc-riscv64-linux-gnu-base AS linux-riscv64-dev-common\n"
        "RUN apt-get update && apt-get install -y gperf flex bison bc\n"
        "RUN mkdir /work-buildlinux\n"
        "WORKDIR /work-buildlinux\n"
        "COPY --from=kernel-patches / /kernel-patches/\n"
        "RUN git clone -b v6.1 --depth 1 https://github.com/torvalds/linux && \\\n"
        "    cd /work-buildlinux/linux && git apply /kernel-patches/linux-riscv-pv-accel.patch\n"
    )
    assert s.count(old_riscv_clone) == 1, "unexpected riscv64 kernel clone stage"
    s = s.replace(old_riscv_clone, new_riscv_clone)

# The target is always riscv64. The stock recipe links a separate RV32 CPU and
# also compiles the 32-bit decoder into the RV64 object. The source patch
# removes that decoder; specialize the one remaining object at compile time.
old_objects = "riscv_machine.o softfp.o riscv_cpu32.o riscv_cpu64.o fs_disk.o"
new_objects = "riscv_machine.o softfp.o riscv_cpu64.o fs_disk.o"
assert s.count(old_objects) == 1, "unexpected TinyEMU object list"
s = s.replace(old_objects, new_objects)
old_cc = "-D_WASI_EMULATED_SIGNAL -DWASI -I/tools/wizer/include/"
new_cc = "-D_WASI_EMULATED_SIGNAL -DWASI -DCONFIG_RISCV_ONLY_64 -DCONFIG_JIT"
if pv_accel:
    new_cc += " -DCONFIG_PV_ACCEL"
# Deterministic replay: derive the RTC from retired instructions instead of
# the host clock. Used by the JIT trace-hash harness (Phase 0).
if os.environ.get("ICOUNT_RTC", "0") == "1":
    new_cc += " -DCONFIG_ICOUNT_RTC"
new_cc += " -I/tools/wizer/include/"
# In-WASM JIT dispatch: export the indirect function table so the host can
# install compiled traces, and allow growing it.
new_cc += " -Wl,--export-table -Wl,--growable-table"
assert s.count(old_cc) == 1, "unexpected TinyEMU compiler command"
s = s.replace(old_cc, new_cc)

# Run Binaryen's optimizer over the linked TinyEMU module before Wizer
# snapshots it. This shrinks the emulator and can improve V8 tiering.
old_config_step = "RUN cat /tinyemu.config.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB envsubst > /out/tinyemu.config"
config_extra = '    drive1: { file: "/agentvm-persist/upper.img" },'
if framebuffer:
    config_extra += '\\n    display0: { device: "simplefb", width: ' + fb_w + ', height: ' + fb_h + ' },'
    config_extra += '\\n    input_device: "virtio",'
if audio:
    config_extra += '\\n    audio_device: "virtio",'
new_config_step = old_config_step + " && sed -i '$i\\" + config_extra + "' /out/tinyemu.config"
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

# Pre-snapshot warm-up. c2w's init runs the boot config's cmd_pre_run
# commands before the Wizer snapshot point, so anything they pull into guest
# RAM (page cache and dentry/negative-dentry caches of the container image
# on the ISO9660 root, kernel slab caches) is part of the snapshot. On a cold
# VM, the first run of python3/node/npm otherwise spends seconds of guest
# kernel time on file reads and path lookups. The warm-up runs the configured
# commands once in a chroot of the container image; every step is optional
# and the script always succeeds, because a failing pre-run command would
# stop init from booting.
if os.environ.get("WARMUP", "1") == "1":
    default_cmds = "; ".join([
        "command -v python3 >/dev/null && python3 -c \"import importlib, importlib.util; "
        "[importlib.import_module(m) for m in ('asyncio http.client json re ssl email unittest "
        "xml.etree.ElementTree subprocess pathlib urllib.request argparse logging typing "
        "dataclasses datetime collections itertools functools shutil tempfile glob hashlib "
        "base64 csv sqlite3 socket threading').split() if importlib.util.find_spec(m)]\"",
        "command -v node >/dev/null && node -e 0",
        "command -v npm >/dev/null && npm --version",
        "command -v git >/dev/null && git --version",
        # The pi image sets NODE_COMPILE_CACHE in its environment; warm the
        # same files the real `pi` startup reads.
        "command -v pi >/dev/null && NODE_COMPILE_CACHE=/usr/local/lib/pi-cache pi --version",
    ])
    cmds = os.environ.get("WARMUP_CMDS", default_cmds)
    script = [
        "#!/bin/sh",
        "# AgentVM pre-snapshot warm-up (see image/build.sh). Always exits 0.",
        "# (init mounts a tmpfs over /etc before pre-run commands: keep files in /sbin)",
        "R=/oci/rootfs",
        "[ -d $R/usr ] || exit 0",
        "mount -t proc proc $R/proc 2>/dev/null",
        "mount -o bind /dev $R/dev 2>/dev/null",
        "mount -t tmpfs tmpfs $R/tmp 2>/dev/null",
        "T=; command -v timeout >/dev/null 2>&1 && T=\"timeout 600\"",
        "$T chroot $R /usr/bin/env -i HOME=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "
        "/bin/sh -c \"$(cat /sbin/agentvm-warmup.cmds)\" >/dev/null 2>&1",
        "umount $R/tmp 2>/dev/null; umount $R/dev 2>/dev/null; umount $R/proc 2>/dev/null",
        "exit 0",
    ]
    def sq(x):
        return "'" + x.replace("'", "'\\''") + "'"
    write_script = (
        "RUN printf '%s\\n' " + " ".join(sq(l) for l in script) +
        " > /rootfs/sbin/agentvm-warmup && chmod 755 /rootfs/sbin/agentvm-warmup && "
        "printf '%s\\n' " + sq(cmds) + " > /rootfs/sbin/agentvm-warmup.cmds\n"
    )
    # The riscv64 VM rootfs stage (the Dockerfile has one per guest arch).
    tini = "COPY --link --from=tini-riscv64-dev /out/tini /rootfs/sbin/tini\n"
    iso = "RUN mkdir /out/ && mkisofs -R -o /out/rootfs.bin /rootfs/\n"
    i = s.index(tini)
    j = s.index(iso, i)
    s = s[:j] + write_script + s[j:]
    initcfg = "RUN mv initconfig.json /out/oci/\n"
    assert s.count(initcfg) == 1, "unexpected create-spec stage"
    s = s.replace(initcfg, initcfg +
        "RUN if grep -q '\"cmd_pre_run\":\\[' /out/oci/initconfig.json; then "
        "sed -i 's#\"cmd_pre_run\":\\[#\"cmd_pre_run\":[[\"/sbin/agentvm-warmup\"],#' /out/oci/initconfig.json; "
        "else sed -i 's#^{#{\"cmd_pre_run\":[[\"/sbin/agentvm-warmup\"]],#' /out/oci/initconfig.json; fi && "
        "grep -o '\"cmd_pre_run\":[^]]*]' /out/oci/initconfig.json\n")
open(p, "w").write(s)
PY

echo "==> Converting to WASM: $OUT (memory ${VM_MEMORY_SIZE_MB} MiB)"
# Optional extra c2w/buildx flags, e.g. IPv4 host mappings on a host without
# working IPv6:
#   C2W_EXTRA_FLAGS='--extra-flag --add-host=archive.ubuntu.com:185.125.190.81'
C2W_EXTRA_ARGS=()
if [ -n "${C2W_EXTRA_FLAGS:-}" ]; then
    read -r -a C2W_EXTRA_ARGS <<< "$C2W_EXTRA_FLAGS"
fi
"$C2W" --target-arch riscv64 \
    --build-arg "VM_MEMORY_SIZE_MB=${VM_MEMORY_SIZE_MB}" \
    --build-arg "LINUX_LOGLEVEL=3" \
    --build-arg "INIT_DEBUG=false" \
    --dockerfile "$WORK/Dockerfile.c2w" \
    --extra-flag "--build-context=tinyemu-patched=$WORK/tinyemu" \
    --extra-flag "--build-context=kernel-patches=$WORK/kernel-patches" \
    "${C2W_EXTRA_ARGS[@]}" \
    "$IMAGE_NAME" \
    "$OUT"

echo "==> Done: $OUT"
ls -lh "$OUT"

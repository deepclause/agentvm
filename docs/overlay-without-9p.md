# Exploration: overlay / mounts without 9p

Status: exploration (separate branch `explore/overlay-without-9p`).

## Problem

`persistentRoot` needs a writable upper layer that survives VM restarts. The
current 9p-backed `/workspace` mount is the only host storage the guest can
see, but overlayfs cannot use it as `upperdir`:

- overlayfs needs `rename(2)`, whiteout `mknod(2)`, and `trusted.overlay.*`
  xattrs on the upper filesystem;
- TinyEMU's 9p server does not implement xattrs at all, and its `fs_mknod`
  returns `P9_ENOTSUP` (see `fs_disk.c` in `ktock/tinyemu-c2w`);
- the WASI layer underneath also has no xattr/mknod path, and Node does not
  expose host xattrs portably.

So overlay-on-9p is not a small patch. This branch explores a different
backing store for the overlay upper layer.

## How the image actually boots (reverse-engineered)

The `.wasm` is a container2wasm image: TinyEMU + a riscv64 Linux kernel + an
OCI rootfs, plus a Go/c2w init.

- TinyEMU config is embedded at `/pack/config`:
  ```
  {
    version: 1,
    machine: "riscv64",
    memory_size: ...,
    bios: "/pack/bbl.bin",
    kernel: "/pack/Image",
    cmdline: "console=hvc0 root=/dev/vda ro ... init=/sbin/tini -- /sbin/init",
    drive0: { file: "/pack/rootfs.bin" },
  }
  ```
- TinyEMU WASI mode creates 9p filesystems:
  - `wasi0` = the WASI root directory (exposes preopened host dirs)
  - `wasi1` = the embedded `/pack` directory
- The c2w init mounts `wasi0`/`wasi1`, then builds the container rootfs with
  overlayfs:
  - `lowerdir=/oci/rootfs` (image rootfs, served by 9p)
  - `upperdir=/run/rootfs-upper` (tmpfs, ephemeral)
  - `workdir=/run/rootfs-work` (tmpfs)
- Our `mounts` option is just another WASI preopen. TinyEMU exposes it through
  the `wasi0` 9p server, and the init bind-mounts it into the guest (e.g.
  `/workspace`). That is why the host workspace behaves like a live 9p mount.

Key kernel facts (from c2w's `linux_rv64_config`):

- `CONFIG_VIRTIO_BLK=y`
- `CONFIG_EXT4_FS=y`
- `# CONFIG_BLK_DEV_LOOP is not set` (loop devices are not available)

## Options considered

1. **Fix 9p for overlayfs.** Requires adding xattr get/set/list to TinyEMU 9p
   and a host-side xattr implementation in the WASI layer. Node has no portable
   xattr API, so this would likely need a sidecar xattr database. High effort,
   still 9p. Rejected as the primary direction.

2. **Loop device on a 9p file.** Create `upper.img` in `/workspace`, `losetup`
   it, format ext4, use as overlay upper. Tested: the guest has `losetup` and
   `mknod`, but the kernel has `CONFIG_BLK_DEV_LOOP` disabled, so
   `losetup` fails with `Operation not permitted`. Would require a kernel
   rebuild to enable loop.

3. **Second virtio block device (`/dev/vdb`) backed by a host file.** The
   kernel already supports `CONFIG_VIRTIO_BLK=y` and `CONFIG_EXT4_FS=y`. The
   host file is just a sparse file under the workspace. TinyEMU accesses it via
   WASI `fopen`/`pread`/`pwrite`, completely bypassing 9p. **This is the
   recommended path.**

4. **virtio-fs / NFS / other.** Not supported by this TinyEMU fork, and NFS
   would need kernel + host server work. Not practical here.

## Recommended design: ext4 upperdir on `drive1` (non-9p)

```
host workspace/
└── .agentvm/
    └── upper.img        # sparse ext4 image (block device for /dev/vdb)

guest /
  lowerdir = current root (c2w image + ephemeral tmpfs overlay)
  upperdir = /mnt/persist/upper   (ext4 on /dev/vdb)
  workdir  = /mnt/persist/work    (ext4 on /dev/vdb)
```

Bootstrap (replaces the snapshot restore in `src/index.js` when this image is
available):

```sh
mkdir -p /mnt/persist
# first boot only: format the block device if it is not ext4
blkid /dev/vdb | grep -q ext4 || mkfs.ext4 -q /dev/vdb
mount /dev/vdb /mnt/persist
mkdir -p /mnt/persist/upper /mnt/persist/work /newroot
mount -t overlay overlay \
  -o lowerdir=/,upperdir=/mnt/persist/upper,workdir=/mnt/persist/work \
  /newroot
mkdir -p /newroot/workspace /newroot/mnt
mount --move /workspace /newroot/workspace 2>/dev/null || \
  mount --bind /workspace /newroot/workspace
cd /newroot
mkdir -p .oldroot
pivot_root . .oldroot && cd /
exec /bin/sh
```

Writes now land in ext4 (which has real rename/whiteout/xattr), so overlayfs
works. The host only sees a single `upper.img` file — no per-file host view of
the overlay, but `/workspace` remains a live 9p share for explicit file
exchange.

### Build-time changes required

1. **Add a second drive to the embedded TinyEMU config.** The config template
   lives in the c2w assets (`config/tinyemu/tinyemu.config.template`). Add:

   ```
   drive1: { file: "/workspace/.agentvm/upper.img" },
   ```

   The path is absolute in the WASI filesystem; `/workspace` is the preopened
   host workspace, so this resolves to `<ws>/.agentvm/upper.img`.

2. **Open additional drives read-write.** The c2w TinyEMU fork hardcodes
   snapshot mode and reopens drives with `fopen(..., "rb")`. The patch in this
   branch (`image/patches/tinyemu-writable-second-drive.patch`) makes drive0
   read-only and every additional drive `BF_MODE_RW` / `"r+b"`.

3. **Provide an ext4 formatter.** Either:
   - add `e2fsprogs` to the image (`image/Dockerfile.acceptance`), and let the
     guest run `mkfs.ext4 /dev/vdb` on first boot; or
   - pre-format a sparse ext4 template at build time and have the host copy it
     into each workspace (no guest/host runtime dependency).

4. **Create `upper.img` before VM start.** `_preparePersistentRoot()` should
   `fs.truncate`/copy the image into `<ws>/.agentvm/upper.img` so TinyEMU can
   open it at boot.

### Runtime changes

- Keep `/workspace` as 9p (it is a good live file share).
- Replace the snapshot restore/save with the overlay bootstrap above.
- Snapshot-on-stop becomes unnecessary; the overlay persists as it writes.
- `persistentRoot` continues to require a `/workspace` mount and uses
  `persistentRootDir` for `upper.img` location.

## What is in this branch

- `docs/overlay-without-9p.md` — this document.
- `image/patches/tinyemu-writable-second-drive.patch` — TinyEMU patch that
  opens `drive1+` read-write (needs to be applied in `image/build.sh` next to
  the existing TinyEMU patches).

## Open items / next steps

- Verify `/workspace/.agentvm/upper.img` is reachable by TinyEMU's WASI
  `fopen` (expected yes, because preopens are visible under the WASI root, but
  needs an image build to confirm).
- Confirm the guest sees `/dev/vdb` with devtmpfs and that
  `mkfs.ext4 /dev/vdb` works.
- Confirm overlayfs accepts ext4 as `upperdir/workdir` and that `apk add` /
  `pip install` / `npm install -g` survive a reboot.
- Decide formatting strategy (guest `e2fsprogs` vs host pre-formatted template).
- Port the `_handleReady`/`stop()` logic in `src/index.js` from snapshot mode
  to the ext4-overlay bootstrap when this image is in use.

## Verification performed

Using the shipped `agentvm-alpine-python.wasm` (no rebuild):

1. **Kernel/device capabilities**
   - `/proc/filesystems` lists `ext4`, `overlay`, and `9p`.
   - `/proc/devices` shows `254 virtblk` and `/proc/partitions` shows `vda`
     (the existing virtio-blk root disk), confirming the guest has a working
     virtio block driver.
   - Creating `/dev/loop0` and running `losetup` fails with
     `Operation not permitted`, confirming loop is not available in this
     kernel.

2. **9p limitations on a mounted `/workspace`**
   - `mkdir`, `touch`, `mv` (rename), and `ln -s` (symlink) succeed.
   - `chmod` fails with `Protocol error` (TinyEMU `fs_setattr` returns
     `P9_ENOTSUP` for mode changes).
   - `mknod` fails with `Protocol error` (TinyEMU `fs_mknod` returns
     `P9_ENOTSUP`), so overlay whiteouts cannot be created.
   - No xattr tools exist in the image; TinyEMU's 9p server has no
     xattr operations at all.

   These are exactly the operations overlayfs needs from an `upperdir`, which
   confirms why overlay-on-9p cannot work without significant 9p/WASI work.

3. **Source-level confirmation**
   - `ktock/tinyemu-c2w` `fs_disk.c` confirms `fs_mknod` is stubbed out with
     `P9_ENOTSUP` and `fs_setattr` rejects mode changes; there are no
     get/set/list xattr handlers.
   - `temu.c` in WASI mode opens every drive via `fopen(..., "rb")` and
     hardcodes `BF_MODE_SNAPSHOT`, which is why the patch in this branch is
     needed for a writable `drive1`.
   - c2w's `linux_rv64_config` confirms `CONFIG_VIRTIO_BLK=y`,
     `CONFIG_EXT4_FS=y`, and `# CONFIG_BLK_DEV_LOOP is not set`.

## Still unverified (requires an image rebuild)

- That `drive1: { file: "/workspace/.agentvm/upper.img" }` resolves through
  Node's WASI preopens from TinyEMU's `fopen` (strongly expected, but only a
  rebuild can confirm).
- That the guest sees `/dev/vdb` and `mkfs.ext4 /dev/vdb` works.
- That overlayfs accepts the ext4 upperdir and that real workloads
  (`apk add`, `pip install`, `npm install -g`) survive a reboot.

Next step to close these gaps: apply the config change + the included TinyEMU
patch in `image/build.sh`, add `e2fsprogs` (or a pre-formatted template image),
and run a two-boot persistence test.

## Full build verification (performed on this branch)

Built a 66 MB test image (`image/Dockerfile.blocktest`, Alpine + `e2fsprogs`)
with the following changes:

- `drive1` added to the embedded TinyEMU config, backed by
  `/workspace/.agentvm/upper.img`
- `image/patches/tinyemu-writable-second-drive.patch` applied
- Wizer maps `/workspace::/workspace` and a 512 MB dummy drive file is created
  at build time
- c2w spec patched to allow block devices and grant `CAP_SYS_ADMIN`

Results:

1. **Second drive is visible to the guest.** `/proc/partitions` shows `vdb`
   (254:16) with the expected 512 MB size, and `/sys/block/vdb` is present.
2. **Device cgroup was blocking block devices.** `open("/dev/vdb")` initially
   returned `EPERM` for `dd`/`blockdev`/`mkfs`. After patching the c2w spec to
   allow block devices, `mkfs.ext4 /dev/vdb` succeeds.
3. **Mounting requires CAP_SYS_ADMIN.** After adding it to the spec, `mount`
   stops returning `EPERM` and reaches the filesystem driver.
4. **Block writes do not persist (remaining blocker).** After
   `dd if=/dev/urandom of=/dev/vdb`, reading back `/dev/vdb` returns zeros and
   the host `upper.img` remains all zeros. `mkfs.ext4` reports success but the
   ext4 superblock is not visible on readback, so `mount -t ext4 /dev/vdb`
   fails with `EINVAL`.

Conclusion: the architecture (a second virtio-blk drive used as an ext4
overlay upperdir) is fundamentally sound and the guest kernel already supports
it, but TinyEMU's WASI runtime currently does not persist writes through the
writable block-device path. The next step is to fix `bf_write_async`/the
WASI update-mode (`r+b`) write-through, or to verify the write path with
TinyEMU's non-WASI `-rw` mode.

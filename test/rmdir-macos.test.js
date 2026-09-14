const { AgentVM } = require('../src/index.js');
const fs = require('node:fs');
const path = require('node:path');

// Regression test for the macOS-only rmdir(2) EPERM bug.
//
// On macOS, unlinking a directory (whether via fs.unlinkSync or the underlying
// unlink(2) syscall) returns EPERM instead of EISDIR. The guest's busybox rmdir
// applet calls unlink() first and only falls back to rmdir() when it sees
// EISDIR, so the bogus EPERM made rmdir abort with "Operation not permitted"
// for directories inside a mounted host root.
//
// The fix in src/worker.js translates that EPERM into WASI_ERRNO_ISDIR (31)
// when the target is actually a directory, so the guest falls back to the
// path_remove_directory handler.
const MOUNT_DIR = path.resolve(__dirname, '../test-mount-rmdir');

function withTimeout(promise, ms = 30_000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

async function test() {
    fs.mkdirSync(MOUNT_DIR, { recursive: true });

    const vm = new AgentVM({ mounts: { '/mnt/data': MOUNT_DIR } });
    await withTimeout(vm.start());

    try {
        // Empty directory: must be removable (this is the pi trust.json.lock case).
        let res = await vm.exec('mkdir /mnt/data/empty && rmdir /mnt/data/empty');
        if (res.exitCode !== 0) {
            throw new Error(`rmdir of empty dir failed: ${JSON.stringify(res)}`);
        }
        if (fs.existsSync(path.join(MOUNT_DIR, 'empty'))) {
            throw new Error('empty dir still exists on host after rmdir');
        }

        // Non-empty directory: must report ENOTEMPTY ("Directory not empty"),
        // NOT "Operation not permitted".
        res = await vm.exec('mkdir /mnt/data/nonempty && touch /mnt/data/nonempty/f && rmdir /mnt/data/nonempty');
        if (res.exitCode === 0) {
            throw new Error('rmdir of non-empty dir unexpectedly succeeded');
        }
        if (!/not empty/i.test(res.stdout + res.stderr)) {
            throw new Error(`expected ENOTEMPTY, got: ${JSON.stringify(res)}`);
        }
    } finally {
        await vm.stop();
        fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
    }
}

test().catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
});

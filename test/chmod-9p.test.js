// chmod on the 9p mount.
//
// Regression test for TinyEMU's fs_setattr returning P9_ENOTSUP for
// P9_SETATTR_MODE: guests saw `chmod` fail with EPROTO on /workspace, which
// broke npm's node_modules/.bin setup, `git init`, `install`, and similar.
// The server now accepts the mode change (a no-op; WASI preview1 has no chmod)
// so the request succeeds.
const { AgentVM } = require('../src/index');
const fs = require('fs');
const path = require('path');

const MOUNT_DIR = path.resolve(__dirname, '../test-mount-chmod');

function withTimeout(promise, ms = 20000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

async function test() {
    fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
    fs.mkdirSync(MOUNT_DIR, { recursive: true });

    const vm = new AgentVM({ mounts: { '/workspace': MOUNT_DIR } });
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };

    try {
        await withTimeout(vm.start(), 60000);

        let res = await withTimeout(vm.exec(
            'touch /workspace/f && chmod +x /workspace/f 2>&1; echo rc=$?'), 20000);
        check('chmod +x on the mount succeeds', res.stdout.includes('rc=0'), res.stdout.trim());
        check('  no "Protocol error"', !res.stdout.includes('Protocol error'), res.stdout.trim());

        res = await withTimeout(vm.exec('chmod 755 /workspace/f 2>&1; echo rc=$?'), 20000);
        check('chmod 755 succeeds', res.stdout.includes('rc=0'), res.stdout.trim());

        res = await withTimeout(vm.exec('chmod 700 /workspace/missing 2>&1; echo rc=$?'), 20000);
        check('chmod on a missing path still fails ENOENT', res.stdout.includes('rc=1'), res.stdout.trim());

        // The real-world cases this unblocks.
        res = await withTimeout(vm.exec(
            'mkdir -p /workspace/proj && cd /workspace/proj && git init -q . && echo hi > g.txt && git add g.txt 2>&1; echo rc=$?'), 30000);
        check('git init/add on the mount', res.stdout.includes('rc=0'), res.stdout.trim());
        check('  no Protocol error', !res.stdout.includes('Protocol error'), res.stdout.trim());
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll chmod tests passed.' : `\n${failures} chmod test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();

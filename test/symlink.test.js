// Symlink creation on a 9p mount.
//
// Regression test: uvwasi (node:wasi) validates the symlink *target* and
// rejects any relative target containing ".." with EINVAL and absolute targets
// with EPERM. That breaks npm, whose node_modules/.bin/* links point at
// "../pkg/bin/cli.js". The worker overrides path_symlink to route the target
// verbatim to fs.symlinkSync.
const { AgentVM } = require('../src/index');
const fs = require('fs');
const path = require('path');

const MOUNT_DIR = path.resolve(__dirname, '../test-mount-symlink');
const VM_DIR = '/mnt/data';

function withTimeout(promise, ms = 10000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

async function test() {
    fs.rmSync(MOUNT_DIR, { recursive: true, force: true });
    fs.mkdirSync(MOUNT_DIR, { recursive: true });

    const vm = new AgentVM({ mounts: { [VM_DIR]: MOUNT_DIR } });
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };

    try {
        await withTimeout(vm.start(), 60000);

        // npm-style nested link: ./node_modules/.bin/x -> ../pkg/bin/cli.js
        let res = await withTimeout(vm.exec(
            'mkdir -p /mnt/data/node_modules/.bin /mnt/data/node_modules/pkg/bin && ' +
            'ln -s ../pkg/bin/cli.js /mnt/data/node_modules/.bin/pkg-cli && echo rc=$?'), 20000);
        check('npm-style ../ symlink', res.stdout.includes('rc=0'), res.stdout.trim() + ' ' + res.stderr.trim());
        check('  host link is a symlink',
            fs.lstatSync(path.join(MOUNT_DIR, 'node_modules/.bin/pkg-cli')).isSymbolicLink());
        check('  host target matches',
            fs.readlinkSync(path.join(MOUNT_DIR, 'node_modules/.bin/pkg-cli')) === '../pkg/bin/cli.js');

        // "./" and plain targets still work.
        res = await withTimeout(vm.exec(
            'ln -s ./pkg/bin/cli.js /mnt/data/dot-link && ' +
            'ln -s pkg/bin/cli.js /mnt/data/plain-link && echo rc=$?'), 20000);
        check('dot/plain targets', res.stdout.includes('rc=0'), res.stdout.trim());

        // Absolute targets are stored verbatim (following them is still
        // sandboxed by path_open).
        res = await withTimeout(vm.exec('ln -s /etc/hostname /mnt/data/abs-link && echo rc=$?'), 20000);
        check('absolute target', res.stdout.includes('rc=0'), res.stdout.trim());

        // Bare ".." target.
        res = await withTimeout(vm.exec('ln -s .. /mnt/data/up-link && echo rc=$?'), 20000);
        check('bare .. target', res.stdout.includes('rc=0'), res.stdout.trim());

        // Overwriting an existing link fails cleanly (does not corrupt).
        res = await withTimeout(vm.exec('ln -s other /mnt/data/plain-link; echo rc=$?'), 20000);
        check('duplicate link rejected', res.stdout.includes('rc=1'), res.stdout.trim());

        // An absolute-target symlink is resolved by the *guest* kernel in the
        // guest namespace, so it must read the guest's own /etc/hostname, not
        // the host's. (The target string is just stored on the host.)
        const guestHostname = (await withTimeout(vm.exec('cat /etc/hostname'), 20000)).stdout.trim();
        res = await withTimeout(vm.exec('cat /mnt/data/abs-link 2>&1'), 20000);
        check('absolute link resolves in guest namespace',
            res.stdout.trim() === guestHostname, 'link=' + res.stdout.trim() + ' guest=' + guestHostname);

        // A host-only file must not be reachable through a symlink even with
        // its absolute host path as the target.
        const hostSecret = '/tmp/agentvm-symlink-secret';
        fs.writeFileSync(hostSecret, 'HOST-SECRET');
        try {
            res = await withTimeout(vm.exec(
                'ln -s ' + hostSecret + ' /mnt/data/secret-link && cat /mnt/data/secret-link 2>&1'), 20000);
            check('host-only file not reachable through symlink',
                !res.stdout.includes('HOST-SECRET'), res.stdout.trim());
        } finally { fs.rmSync(hostSecret, { force: true }); }

        // Unlink works.
        res = await withTimeout(vm.exec('rm /mnt/data/abs-link && echo rc=$?'), 20000);
        check('unlink symlink', res.stdout.includes('rc=0') && !fs.existsSync(path.join(MOUNT_DIR, 'abs-link')));
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll symlink tests passed.' : `\n${failures} symlink test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();

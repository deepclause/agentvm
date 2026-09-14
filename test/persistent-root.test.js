'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentVM } = require('../src/index');

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentvm-persist-'));
}

test('persistentRootDir defaults to .agentvm under /workspace', () => {
    const ws = tmpWorkspace();
    try {
        const vm = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true });
        vm._preparePersistentRoot();
        assert.equal(vm.persistentRootGuestDir, '/workspace/.agentvm');
        assert.equal(fs.existsSync(path.join(ws, '.agentvm', 'upper')), true);
        assert.equal(fs.existsSync(path.join(ws, '.agentvm', 'work')), true);
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
    }
});

test('persistentRootDir accepts relative and absolute guest paths under /workspace', () => {
    const ws = tmpWorkspace();
    try {
        const relative = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, persistentRootDir: 'state/root' });
        relative._preparePersistentRoot();
        assert.equal(relative.persistentRootGuestDir, '/workspace/state/root');
        assert.equal(fs.existsSync(path.join(ws, 'state', 'root', 'upper')), true);

        const absolute = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, persistentRootDir: '/workspace/.pi-box/overlay' });
        absolute._preparePersistentRoot();
        assert.equal(absolute.persistentRootGuestDir, '/workspace/.pi-box/overlay');
        assert.equal(fs.existsSync(path.join(ws, '.pi-box', 'overlay', 'upper')), true);
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
    }
});

test('persistentRootDir outside /workspace is rejected', () => {
    const ws = tmpWorkspace();
    try {
        const vm = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, persistentRootDir: '/elsewhere' });
        assert.throws(() => vm._preparePersistentRoot(), /under the "\/workspace" mount/);
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
    }
});

test('persistentRoot requires a /workspace mount', () => {
    const vm = new AgentVM({ mounts: { '/mnt/data': '/tmp' }, persistentRoot: true });
    assert.throws(() => vm._preparePersistentRoot(), /requires a "\/workspace" mount/);
});

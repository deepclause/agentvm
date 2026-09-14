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

test('persistentRootDir defaults to a host path beside the workspace mount', () => {
    const ws = tmpWorkspace();
    try {
        const vm = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true });
        vm._preparePersistentRoot();
        assert.equal(vm.persistentRootGuestDir, '/agentvm-persist');
        assert.equal(vm.persistentRootHostDir, path.join(ws, '.agentvm'));
        assert.equal(fs.existsSync(path.join(ws, '.agentvm', 'upper.img')), true);
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
    }
});

test('persistentRootDir accepts an explicit host path', () => {
    const ws = tmpWorkspace();
    const state = tmpWorkspace();
    try {
        const vm = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, persistentRootDir: state });
        vm._preparePersistentRoot();
        assert.equal(vm.persistentRootHostDir, state);
        assert.equal(fs.existsSync(path.join(state, 'upper.img')), true);
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(state, { recursive: true, force: true });
    }
});

test('persistentRoot without a workspace mount requires persistentRootDir', () => {
    const vm = new AgentVM({ mounts: { '/mnt/data': '/tmp' }, persistentRoot: true });
    assert.throws(() => vm._preparePersistentRoot(), /persistentRootDir/);
});

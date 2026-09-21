'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentVM } = require('../src/index');

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentvm-persist-it-'));
}

function normalize(value) {
    return String(value).replace(/\r\n/g, '\n').trim();
}

test('persistentRoot persists files across VM restarts', { timeout: 900000 }, async () => {
    const ws = tmpWorkspace();
    try {
        const vm1 = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, network: false });
        await vm1.start();
        let res = await vm1.exec('mkdir -p /etc/mymarker; echo hello > /root/test.txt; echo marker > /etc/mymarker/f; cat /root/test.txt; cat /etc/mymarker/f');
        assert.equal(normalize(res.stdout), 'hello\nmarker');
        await vm1.snapshotRoot();
        await vm1.stop();

        const vm2 = new AgentVM({ mounts: { '/workspace': ws }, persistentRoot: true, network: false });
        await vm2.start();
        res = await vm2.exec('cat /root/test.txt; cat /etc/mymarker/f');
        assert.equal(normalize(res.stdout), 'hello\nmarker');
        await vm2.stop();
    } finally {
        fs.rmSync(ws, { recursive: true, force: true });
    }
});

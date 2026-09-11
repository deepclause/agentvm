/**
 * AgentVM 0.2 ultimate acceptance test.
 *
 * Boots the riscv64 Alpine image that ships Python + Node/npm, then exercises
 * the exact workloads an agent VM must support:
 *
 *   1. toolchain version checks (python3, pip, node, npm)
 *   2. `pip install` a small pure-Python package (HTTPS + build)
 *   3. `npm install` a small package (many concurrent HTTPS requests)
 *   4. `npm install -g @earendil-works/pi-coding-agent` (large, many deps)
 *   5. run the installed `pi` agent
 *
 * Usage:
 *   node test/acceptance.test.js [path/to/image.wasm]
 *
 * Env:
 *   AGENTVM_WASM      path to the image (overrides argv)
 *   AGENTVM_SKIP_PI   1 to skip the heavy pi install
 */

const { AgentVM } = require('../src/index.js');
const fs = require('node:fs');
const path = require('node:path');

const wasmPath = process.env.AGENTVM_WASM
    || process.argv[2]
    || path.join(__dirname, '../image/agentvm-alpine-python-node.wasm');

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
    ]);
}

let passed = 0;
let failed = 0;

function report(name, ok, detail = '') {
    if (ok) {
        passed++;
        console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    }
}

async function main() {
    if (!fs.existsSync(wasmPath)) {
        console.error(`Image not found: ${wasmPath}`);
        console.error('Build it first:  cd image && ./build.sh');
        process.exit(2);
    }

    console.log(`=== AgentVM 0.2 acceptance test ===`);
    console.log(`image: ${wasmPath}`);
    console.log('starting VM (network enabled)...\n');

    const vm = new AgentVM({ wasmPath, network: true });
    const t0 = Date.now();
    await withTimeout(vm.start(), 120000);
    console.log(`VM ready in ${Date.now() - t0} ms\n`);

    try {
        // 1. Toolchain
        console.log('--- 1. toolchain ---');
        let r = await vm.exec('python3 --version && pip --version && node --version && npm --version');
        report('python3/pip/node/npm versions', r.exitCode === 0
            && /Python/.test(r.stdout) && /pip/.test(r.stdout)
            && /v2[0-9]/.test(r.stdout) && /\d+\.\d+\.\d+/.test(r.stdout), r.stdout.trim().split('\n').join(' | '));

        // 2. pip install (pure Python, exercises HTTPS download)
        console.log('--- 2. pip install ---');
        r = await withTimeout(vm.exec('pip install --no-cache-dir cowsay 2>&1 | tail -3'), 300000);
        report('pip install cowsay', r.exitCode === 0 && /Successfully installed cowsay/.test(r.stdout), r.stdout.trim().split('\n').pop());

        // 3. npm install (many small concurrent HTTPS requests)
        console.log('--- 3. npm install ---');
        r = await withTimeout(vm.exec('cd /tmp && npm init -y >/dev/null 2>&1 && npm install is-number 2>&1 | tail -3 && node -e "console.log(require(\\"/tmp/node_modules/is-number\\")(5))"'), 300000);
        report('npm install is-number', r.exitCode === 0 && r.stdout.includes('true'), r.stdout.trim().split('\n').pop());

        // 4 + 5. install and run the pi coding agent
        if (process.env.AGENTVM_SKIP_PI === '1') {
            console.log('--- 4/5. pi agent (skipped via AGENTVM_SKIP_PI=1) ---');
        } else {
            console.log('--- 4. install pi coding agent (large npm install) ---');
            r = await withTimeout(vm.exec('npm install -g @earendil-works/pi-coding-agent 2>&1 | tail -5'), 1800000);
            report('npm install -g @earendil-works/pi-coding-agent', r.exitCode === 0, r.stdout.trim().split('\n').pop());

            console.log('--- 5. run pi agent ---');
            r = await withTimeout(vm.exec('pi --help 2>&1 | head -3'), 60000);
            report('pi --help', r.exitCode === 0 && /pi - AI coding assistant/.test(r.stdout), r.stdout.trim().split('\n')[0]);
        }
    } finally {
        await vm.stop();
    }

    console.log(`\n=== acceptance summary: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('acceptance test crashed:', e);
    process.exit(1);
});

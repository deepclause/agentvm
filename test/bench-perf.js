'use strict';
// Ad-hoc performance probe. Boots the VM and times representative guest
// CPU / startup / syscall workloads. Not part of the test suite.
const { AgentVM } = require('../src/index.js');
const path = require('node:path');

const wasmPath = process.env.AGENTVM_WASM || process.argv[2]
    || path.join(__dirname, '../agentvm-alpine-python.wasm');

function fmt(ms) { return `${ms.toFixed(0)}ms`; }

async function timed(label, fn, warm = 1) {
    // warmup runs are not counted
    for (let i = 0; i < warm; i++) await fn();
    const t0 = Date.now();
    const r = await fn();
    const ms = Date.now() - t0;
    console.log(`${label.padEnd(46)} ${fmt(ms).padStart(9)}   ${String(r.stdout || '').trim().replace(/\n/g, ' ').slice(0, 60)}`);
    return ms;
}

async function main() {
    console.log(`image: ${wasmPath}`);
    const vm = new AgentVM({ wasmPath, network: false });
    let t0 = Date.now();
    await vm.start();
    console.log(`boot: ${fmt(Date.now() - t0)}`);

    // How fast is a trivial guest exec round-trip?
    await timed('true (round trip)', () => vm.exec('true'), 2);

    // Guest shell / process spawn cost
    await timed('/bin/true (spawn)', () => vm.exec('/bin/true'), 1);

    // Python interpreter startup
    await timed('python3 -c pass (startup)', () => vm.exec('python3 -c pass'), 1);

    // Python CPU: tight integer loop (pure bytecode interpreter)
    await timed('python3 sum(1..2e6)', () => vm.exec('python3 -c "print(sum(range(2000000)))"'), 1);

    // Python float loop
    await timed('python3 float loop 2e6', () => vm.exec('python3 -c "s=0.0\\nfor i in range(2000000): s+=i*0.5\\nprint(s)"'), 1);

    // Node startup
    await timed('node -e 1 (startup)', () => vm.exec('node -e "process.exit(0)"'), 1);

    // Node CPU: tight loop
    await timed('node tight loop 5e6', () => vm.exec('node -e "let s=0; for(let i=0;i<5000000;i++) s+=i; console.log(s)"'), 1);

    // For comparison, host CPU: run the same loop on host Node? not here.
    // Compiled C (busybox) baseline
    await timed('busybox sh -c "i=0; while..."', () => vm.exec('i=0; while [ $i -lt 50000 ]; do i=$((i+1)); done; echo $i'), 1);

    await vm.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });

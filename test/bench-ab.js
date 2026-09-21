'use strict';
// A/B benchmark for two AgentVM images.
//
// Usage:
//   node test/bench-ab.js <imageA.wasm> <imageB.wasm> [reps]
//
// Boots each image once (warm persistent VM), runs every workload `reps`
// times after one warm-up, and reports the median. The label "A/B speedup"
// is A_ms / B_ms, so >1 means B is faster.
//
// The workload set deliberately mixes:
//   - process startup (syscalls, dynamic linking, page faults)
//   - tight integer loops (interpreter-bound)
//   - large anonymous allocations (page zeroing / copy -> the PV target)

const { AgentVM } = require('../src/index.js');
const fs = require('node:fs');

const WASM_A = process.argv[2];
const WASM_B = process.argv[3];
const REPS = Number(process.argv[4] || 3);

if (!WASM_A || !WASM_B) {
    console.error('usage: node test/bench-ab.js <a.wasm> <b.wasm> [reps]');
    process.exit(2);
}

const WORKLOADS = [
    ['python-startup', 'python3 -c pass'],
    ['node-startup', 'node -e "process.exit(0)"'],
    ['python-sum-2e6', 'python3 -c "print(sum(range(2000000)))"'],
    ['node-loop-5e6', 'node -e "let s=0;for(let i=0;i<5000000;i++)s+=i;console.log(s)"'],
    ['py-alloc-5e6-list', 'python3 -c "x=[0.0]*5000000; print(len(x))"'],
    ['py-bytearray-200MB', 'python3 -c "b=bytearray(200*1024*1024); print(len(b))"'],
    ['node-buffer-200MB', 'node -e "const b=Buffer.alloc(200*1024*1024); console.log(b.length)"'],
    ['py-dict-1e6', 'python3 -c "d={i:i for i in range(1000000)}; print(len(d))"'],
];

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
    ]);
}

async function measureImage(label, wasmPath, reps) {
    if (!fs.existsSync(wasmPath)) throw new Error(`image not found: ${wasmPath}`);
    const vm = new AgentVM({ wasmPath, network: false });
    const bootT0 = Date.now();
    await withTimeout(vm.start(), 180000);
    console.log(`[${label}] boot ${Date.now() - bootT0} ms  (${wasmPath})`);
    const results = {};
    try {
        for (const [name, cmd] of WORKLOADS) {
            // warm-up (also catches crashes early)
            await withTimeout(vm.exec(cmd), 600000);
            const times = [];
            for (let i = 0; i < reps; i++) {
                const t0 = Date.now();
                const r = await withTimeout(vm.exec(cmd), 600000);
                times.push(Date.now() - t0);
                if (r.exitCode !== 0) throw new Error(`${name} exit ${r.exitCode}: ${r.stderr}`);
            }
            times.sort((a, b) => a - b);
            const median = times[Math.floor(times.length / 2)];
            results[name] = median;
            console.log(`[${label}] ${name.padEnd(24)} ${String(median).padStart(8)} ms`);
        }
    } finally {
        await vm.stop();
    }
    return results;
}

async function main() {
    console.log(`A=${WASM_A}\nB=${WASM_B}\nreps=${REPS}\n`);
    const a = await measureImage('A', WASM_A, REPS);
    const b = await measureImage('B', WASM_B, REPS);
    console.log('\n--- summary (B vs A) ---');
    console.log('workload'.padEnd(24), 'A(ms)'.padStart(8), 'B(ms)'.padStart(8), 'A/B'.padStart(7));
    for (const [name] of WORKLOADS) {
        const av = a[name], bv = b[name];
        const speedup = bv > 0 ? (av / bv) : 0;
        console.log(name.padEnd(24), String(av).padStart(8), String(bv).padStart(8),
            speedup.toFixed(2).padStart(7));
    }
}

main().catch((e) => { console.error(e); process.exit(1); });

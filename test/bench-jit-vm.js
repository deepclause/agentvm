'use strict';
// Compare a JIT-enabled and JIT-disabled boot of the same image.
//   node test/bench-jit-vm.js <image.wasm> [reps]
const { AgentVM } = require('../src/index.js');

const WASM = process.argv[2];
const REPS = Number(process.argv[3] || 3);
const WORKLOADS = [
    ['intloop-50M', '/tmp/intloop'],
    ['node-startup', 'node -e "process.exit(0)"'],
    ['node-int-loop', 'node -e "let s=1;for(let i=0;i<3000000;i++){s+=i;s^=(s>>7);s+=i^s;s-=(s>>3);}console.log(s)"'],
    ['python-sum-2e6', 'python3 -c "print(sum(range(2000000)))"'],
];
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]); }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function measure(jitEnabled) {
    process.env.AGENTVM_JIT = jitEnabled ? '1' : '0';
    const vm = new AgentVM({ wasmPath: WASM, network: false, mounts: { '/mnt': '/tmp' } });
    await withTimeout(vm.start(), 180000);
    await vm.exec('cp /mnt/intloop /tmp/intloop; chmod +x /tmp/intloop');
    const out = {};
    try {
        for (const [name, cmd] of WORKLOADS) {
            await withTimeout(vm.exec(cmd), 600000);
            const ts = [];
            for (let i = 0; i < REPS; i++) {
                const t0 = Date.now();
                await withTimeout(vm.exec(cmd), 600000);
                ts.push(Date.now() - t0);
            }
            out[name] = median(ts);
        }
    } finally { await vm.stop(); }
    return out;
}

(async () => {
    console.log(`image=${WASM} reps=${REPS}`);
    const off = await measure(false);
    const on = await measure(true);
    console.log('\nworkload'.padEnd(20), 'JIT off'.padStart(9), 'JIT on'.padStart(9), 'on/off'.padStart(8));
    for (const [name] of WORKLOADS) {
        const speedup = on[name] > 0 ? (off[name] / on[name]) : 0;
        console.log(name.padEnd(20), String(off[name]).padStart(9), String(on[name]).padStart(9), speedup.toFixed(2).padStart(8));
    }
})().catch((e) => { console.error(e); process.exit(1); });

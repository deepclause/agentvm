'use strict';
// Sequential single-image benchmark (no concurrent VM).
//   node test/bench-one.js <image.wasm> [reps]
const { AgentVM } = require('../src/index.js');

const W = process.argv[2];
const REPS = Number(process.argv[3] || 5);
const WORKLOADS = [
    ['python-startup', 'python3 -c pass'],
    ['node-startup', 'node -e "process.exit(0)"'],
    ['py-bytearray-200MB', 'python3 -c "b=bytearray(200*1024*1024); print(len(b))"'],
    ['node-buffer-200MB', 'node -e "const b=Buffer.alloc(200*1024*1024); console.log(b.length)"'],
    ['py-dict-1e6', 'python3 -c "d={i:i for i in range(1000000)}; print(len(d))"'],
];
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]); }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
    const vm = new AgentVM({ wasmPath: W, network: false });
    await withTimeout(vm.start(), 180000);
    try {
        for (const [name, cmd] of WORKLOADS) {
            await withTimeout(vm.exec(cmd), 600000); // warmup
            const ts = [];
            for (let i = 0; i < REPS; i++) {
                const t0 = Date.now();
                await withTimeout(vm.exec(cmd), 600000);
                ts.push(Date.now() - t0);
            }
            console.log(`${name.padEnd(22)} median=${String(median(ts)).padStart(6)}ms  min=${String(Math.min(...ts)).padStart(6)}ms  [${ts.join(',')}]`);
        }
    } finally { await vm.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });

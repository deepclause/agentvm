'use strict';

// Run the riscv-tests binaries (see build.sh) inside AgentVM three times, so
// later passes execute translated code. Combine with:
//   AGENTVM_JIT_V2=1 AGENTVM_JIT_V2_HOT_THRESHOLD=1 [AGENTVM_JIT_V2_VERIFY=1]
// Usage: node test/riscv-tests/run.js [bindir] [--wasm PATH]
//
// Known TinyEMU failures (also without the JIT; all pass under QEMU):
// rv64ua-lrsc, rv64ud-move, rv64ud-recoding.

const path = require('node:path');
const { AgentVM } = require('../../src/index');

const args = process.argv.slice(2);
const wasmIdx = args.indexOf('--wasm');
const wasmPath = wasmIdx >= 0 ? path.resolve(args.splice(wasmIdx, 2)[1]) : undefined;
const binDir = path.resolve(args[0] || '/tmp/riscv-tests-out');
const KNOWN = new Set(['rv64ua-lrsc', 'rv64ud-move', 'rv64ud-recoding']);

(async () => {
    const vm = new AgentVM({ wasmPath, network: false, mounts: { '/rvt': binDir } });
    await vm.start();
    // The 9p mount does not expose mode bits; copy into guest RAM and chmod.
    const script = 'cp -r /rvt /root/t && chmod +x /root/t/* && cd /root/t && ' +
        'for pass in 1 2 3; do p=0; f=""; for t in *; do ./$t >/dev/null 2>&1; rc=$?; ' +
        'if [ $rc -eq 0 ]; then p=$((p+1)); else f="$f $t:$rc"; fi; done; echo "PASS$pass ok=$p failed:$f"; done';
    const r = await vm.exec(script);
    await vm.stop();
    console.log(r.stdout.trim());
    let unexpected = 0;
    for (const line of r.stdout.trim().split('\n')) {
        const failed = (line.split('failed:')[1] || '').trim().split(/\s+/).filter(Boolean);
        for (const f of failed) if (!KNOWN.has(f.split(':')[0])) unexpected++;
    }
    console.log(unexpected ? `UNEXPECTED FAILURES: ${unexpected}` : 'riscv-tests: only known TinyEMU failures');
    process.exit(unexpected ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

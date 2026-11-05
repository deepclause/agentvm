#!/usr/bin/env node
'use strict';

// JIT benchmark harness. Measures wall time, guest uptime delta and (optionally)
// retired guest instructions, so results can be compared across the
// interpreter, the synchronous MVP JIT and the async region JIT.
//
// Usage:
//   node test/bench-jit.js [--wasm PATH] [--insn] [--json] [--only name,...]
//
// Guest instruction counting uses a small mmap'd `csrr a0, instret` stub in
// the guest Python. It is off by default because it forks a process per
// measurement.

const path = require('node:path');
const { AgentVM } = require('../src/index');

const DEFAULT_WASM = path.resolve(__dirname, '../agentvm-alpine-python.wasm');

const INSNS_PY = [
    'import ctypes,mmap',
    'code=bytes.fromhex("732502c067800000")',
    'm=mmap.mmap(-1,len(code),prot=mmap.PROT_READ|mmap.PROT_WRITE|mmap.PROT_EXEC)',
    'm.write(code)',
    'f=ctypes.CFUNCTYPE(ctypes.c_uint64)(ctypes.addressof(ctypes.c_char.from_buffer(m)))',
    'print(f())',
].join(';');

const WORKLOADS = [
    {
        name: 'python-int-loop',
        kind: 'micro',
        cmd: 'python3 -c "i=0\nwhile i<1000000: i+=1\nprint(i)"',
    },
    {
        name: 'python-heavy-imports',
        kind: 'startup',
        cmd: 'python3 -c "import asyncio,http.client,json,re,ssl,email,unittest,xml.etree.ElementTree;print(0)"',
    },
    {
        name: 'python-startup',
        kind: 'startup',
        cmd: 'python3 -c pass',
    },
    {
        name: 'node-int-loop',
        kind: 'micro',
        cmd: 'node -e "let i=0;while(i<1000000)i++;console.log(i)"',
    },
    {
        name: 'node-f64-loop',
        kind: 'micro',
        cmd: 'node -e "const a=new Float64Array(1024);for(let n=0;n<100000;n++){for(let i=0;i<1024;i++)a[i]+=1}console.log(a[0])"',
    },
    {
        name: 'node-startup',
        kind: 'startup',
        cmd: 'node -e 0',
    },
    {
        name: 'npm-version',
        kind: 'startup',
        cmd: 'npm --version',
    },
    // V8 without runtime code generation (`--jitless`): everything runs in
    // the embedded bytecode interpreter of the node binary, which the region
    // JIT translates once, instead of fresh V8 code in every process.
    {
        name: 'npm-version-jitless',
        kind: 'startup',
        cmd: 'NODE_OPTIONS=--jitless npm --version',
    },
    {
        name: 'node-startup-jitless',
        kind: 'startup',
        cmd: 'node --jitless -e 0',
    },
    {
        name: 'node-int-loop-jitless',
        kind: 'micro',
        cmd: 'node --jitless -e "let i=0;while(i<1000000)i++;console.log(i)"',
    },
    {
        name: 'stat-loop',
        kind: 'micro',
        cmd: 'python3 -c "import os\nfor i in range(2000): os.stat(\'/\')\nprint(0)"',
    },
    {
        name: 'fork-exec-50',
        kind: 'system',
        cmd: 'i=0; while [ $i -lt 50 ]; do /bin/true; i=$((i+1)); done; echo $i',
    },
];

function parseArgs(argv) {
    const out = { wasm: DEFAULT_WASM, insn: false, json: false, only: null, repeat: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--wasm') out.wasm = path.resolve(argv[++i]);
        else if (a === '--insn') out.insn = true;
        else if (a === '--json') out.json = true;
        else if (a === '--repeat') out.repeat = Math.max(1, Number(argv[++i]) || 1);
        else if (a === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim()));
        else if (a === '--help' || a === '-h') {
            console.log('usage: node test/bench-jit.js [--wasm PATH] [--insn] [--json] [--only name,...] [--repeat N]');
            process.exit(0);
        }
    }
    return out;
}

function guestUptime(vm) {
    return vm.exec('cat /proc/uptime').then((r) => Number.parseFloat(r.stdout.trim().split(/\s+/)[0]));
}

async function guestInsn(vm) {
    const r = await vm.exec(`python3 -c '${INSNS_PY}'`);
    const value = r.stdout.trim().split(/\s+/).pop();
    return BigInt(value || '0');
}

async function runWorkload(vm, w, opts) {
    const wall0 = process.hrtime.bigint();
    const up0 = await guestUptime(vm);
    const insn0 = opts.insn ? await guestInsn(vm) : 0n;

    const result = await vm.exec(w.cmd);
    if (result.exitCode !== 0) {
        throw new Error(`${w.name} failed: ${result.stderr || result.stdout}`);
    }

    const up1 = await guestUptime(vm);
    const insn1 = opts.insn ? await guestInsn(vm) : 0n;
    const wall1 = process.hrtime.bigint();

    const wall = Number(wall1 - wall0) / 1e9;
    const guest = up1 - up0;
    const insns = opts.insn ? insn1 - insn0 : null;
    return {
        name: w.name,
        kind: w.kind,
        wall,
        guest,
        insns: insns === null ? null : insns.toString(),
        mips: insns && guest > 0 ? Number(insns) / guest / 1e6 : null,
        output: (result.stdout || '').trim().split('\n').pop(),
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    // The emulator's main loop never returns, so ask the worker to post its
    // counters periodically; otherwise getJitStats() would stay empty.
    if (process.env.AGENTVM_JIT_V2 === '1' && process.env.DEBUG_JIT_STATS === undefined) {
        process.env.DEBUG_JIT_STATS = '1';
    }
    const vm = new AgentVM({
        wasmPath: opts.wasm,
        network: false,
        debug: process.env.DEBUG_JIT === '1',
    });
    await vm.start();
    const results = [];
    try {
        for (const w of WORKLOADS) {
            if (opts.only && !opts.only.has(w.name)) continue;
            // Warm the command interpreter once so timing excludes the first
            // shell fork/exec. This matches the methodology in docs/jit-plan.md.
            await vm.exec('/bin/true');
            // With --repeat, the workload runs N times in the same VM: `wall`
            // is the first (cold) run, `best` the fastest (warm) run.
            const runs = [];
            for (let k = 0; k < opts.repeat; k++) runs.push(await runWorkload(vm, w, opts));
            const r = runs[0];
            r.runs = runs.map((x) => x.wall);
            r.best = Math.min(...r.runs);
            results.push(r);
            if (!opts.json) {
                const mips = r.mips ? ` ${r.mips.toFixed(1)} MIPS` : '';
                const insns = r.insns ? ` ${r.insns} insns` : '';
                const best = opts.repeat > 1 ? `  best ${r.best.toFixed(3)}s` : '';
                console.log(`${r.name.padEnd(22)} wall ${r.wall.toFixed(3)}s  guest ${r.guest.toFixed(3)}s${best}${insns}${mips}`);
            }
        }
    } finally {
        const stats = vm.getJitStats();
        await vm.stop().catch(() => {});
        if (opts.json) {
            console.log(JSON.stringify({ results, jit: stats }, null, 2));
        } else if (stats) {
            console.log('JIT stats:', JSON.stringify(stats));
        }
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});

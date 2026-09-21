'use strict';

// Straight-line leaf call inlining: the trace continues after a call by
// inlining the callee body. Instructions are non-contiguous, so the translator
// uses an explicit per-instruction offset array.

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

const REGS = 0x1000;
const START = 0x1000n;

function run(instructions, sizes, offsets, inline, init) {
    const jit = new RiscVBlockJit(instructions, sizes, {
        directTlb: true, registerLocals: true, offsets, inline,
    });
    const module = jit.compile();
    const memory = new WebAssembly.Memory({ initial: 2 });
    const view = new DataView(memory.buffer);
    for (const [r, v] of Object.entries(init || {})) view.setBigUint64(REGS + r * 8, BigInt(v), true);
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    const next = instance.exports.run(REGS, 0, START, 0, 0);
    const reg = (r) => view.getBigInt64(REGS + r * 8, true);
    return { next, reg };
}

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  PASS ${name}`); }

// jal ra, +0x100 ; <callee at 0x100: addi x5,x5,1> ; addi x6,x6,2
check('inlined call writes ra and runs the callee body', () => {
    const call = 0x100000ef; // jal x1, +0x100
    const calleeAddi = 0x00128293; // addi x5, x5, 1
    const after = 0x00230313;      // addi x6, x6, 2
    const { next, reg } = run(
        [call, calleeAddi, after],
        [4, 4, 4],
        [0, 0x100, 4], // callee lives at traceStart+0x100
        new Set([0]),
        { 5: 0, 6: 0 },
    );
    assert.strictEqual(reg(5), 1n, 'callee ran (x5)');
    assert.strictEqual(reg(6), 2n, 'caller continued (x6)');
    assert.strictEqual(reg(1), START + 4n, 'ra = return address');
    assert.strictEqual(next, START + 8n, 'fall-through after the caller continuation');
});

// A loop whose body calls a leaf, then branches back to the start.
check('loop with an inlined call forms a self-loop', () => {
    // 0: jal x1, +0x100        (call helper)
    // (inlined) 0x100: addi x5,x5,1
    // 4: addi x6,x6,2
    // 8: blt x6,x7,-8          (back edge to start)
    const call = 0x100000ef;
    const calleeAddi = 0x00128293;
    const after = 0x00230313;
    const back = 0xfe734ce3; // blt x6, x7, -8
    const jit = new RiscVBlockJit([call, calleeAddi, after, back], [4, 4, 4, 4], {
        directTlb: true, registerLocals: true, offsets: [0, 0x100, 4, 8], inline: new Set([0]),
    });
    const module = jit.compile();
    assert(jit.selfLoop, 'detected as a self-loop');
    const memory = new WebAssembly.Memory({ initial: 2 });
    const view = new DataView(memory.buffer);
    view.setBigUint64(REGS + 5 * 8, 0n, true);
    view.setBigUint64(REGS + 6 * 8, 0n, true);
    view.setBigUint64(REGS + 7 * 8, 3n, true); // loop 3 times
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    instance.exports.run(REGS, 0, START, 0, 0);
    assert.strictEqual(view.getBigInt64(REGS + 5 * 8, true), 2n, 'x5 incremented per iteration');
    assert.strictEqual(view.getBigInt64(REGS + 6 * 8, true), 4n, 'x6 incremented per iteration');
});

console.log(`inline JIT: ${n} checks passed`);

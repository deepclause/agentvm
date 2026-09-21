'use strict';

// Self-loop blocks: a block whose terminal branch targets its own start is
// executed as an internal WASM loop, so a hot loop pays the host dispatch once
// per LOOP_BUDGET iterations.

const assert = require('node:assert');
const { RiscVBlockJit, LOOP_BUDGET } = require('../src/jit');

const REGS = 0x1000;

function compile(insns, sizes) {
    const jit = new RiscVBlockJit(insns, sizes, { directTlb: true, registerLocals: true });
    const module = jit.compile();
    const memory = new WebAssembly.Memory({ initial: 2 });
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    const view = new DataView(memory.buffer);
    return {
        selfLoop: jit.selfLoop,
        run: (regs, startPc) => {
            for (const [r, v] of Object.entries(regs)) view.setBigUint64(REGS + r * 8, BigInt(v), true);
            return instance.exports.run(REGS, 0, BigInt(startPc), 0, 0);
        },
        reg: (r) => view.getBigInt64(REGS + r * 8, true),
    };
}

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  PASS ${name}`); }

// addi x1,x1,1 ; blt x1,x2,-4   (x2 = 5)
check('conditional self-loop runs to the exit', () => {
    const c = compile([0x00108093, 0xfe20cee3], [4, 4]);
    assert(c.selfLoop, 'detected as a self-loop');
    const next = c.run({ 1: 0, 2: 5 }, 0x100);
    assert.strictEqual(next, 0x100n + 8n, 'falls through after the terminal');
    assert.strictEqual(c.reg(1), 5n, 'x1 reached the bound');
});

// addi x1,x1,1 ; jal x0,-4   (infinite loop -> budget-limited)
check('unconditional self-loop stops at the budget', () => {
    const c = compile([0x00108093, 0xffdff06f], [4, 4]);
    assert(c.selfLoop, 'detected as a self-loop');
    const next = c.run({ 1: 0 }, 0x100);
    assert.strictEqual(next, 0x100n, 'returns the block start so the interpreter can service interrupts');
    assert.strictEqual(c.reg(1), BigInt(LOOP_BUDGET), 'ran exactly LOOP_BUDGET iterations');
});

// A branch that targets inside (not the start of) the block is not self-looping.
check('a non-self branch is not treated as a loop', () => {
    const c = compile([0x00000463], [4]); // beq x0,x0,+8 (forward target)
    assert(!c.selfLoop);
});

console.log(`self-loop JIT: ${n} checks passed`);

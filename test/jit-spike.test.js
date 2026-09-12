'use strict';

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

function compile(instructions) {
    const module = new RiscVBlockJit(instructions.map((n) => n >>> 0)).compile();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    return { run: instance.exports.run, view: new BigInt64Array(memory.buffer) };
}

async function main() {
    // Block 1: addi x1, x0, 5; jal x0, +8
    {
        const { run, view } = compile([0x00500093, 0x0080006f]);
        const next = run(0, 0);
        assert.strictEqual(view[1], 5n, 'x1 = 5');
        assert.strictEqual(next, 12, 'jal at pc=4 returns pc + imm');
    }

    // Block 2: bne x1, x2, +12 (not taken); addi x3, x0, 9
    {
        const { run, view } = compile([0x00209063, 0x00900193]);
        const next = run(0, 0);
        assert.strictEqual(next, 8, 'branch not taken falls through');
        assert.strictEqual(view[3], 9n, 'x3 = 9');
    }

    // Block 3: beq x0, x0, +8 (taken); addi x4, x0, 7 should be skipped
    {
        const { run, view } = compile([0x00000463, 0x00700213]);
        const next = run(0, 0);
        assert.strictEqual(next, 8, 'branch taken jumps over addi');
        assert.strictEqual(view[4], 0n, 'skipped instruction did not run');
    }

    console.log('JIT spike passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

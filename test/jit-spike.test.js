'use strict';

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

function compile(instructions) {
    const module = new RiscVBlockJit(instructions.map((n) => n >>> 0)).compile();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    return {
        run: (regs, memBase, pc) => Number(instance.exports.run(regs, memBase, BigInt(pc))),
        view: new BigInt64Array(memory.buffer),
        data: new DataView(memory.buffer),
    };
}

async function main() {
    // Block 1: addi x1, x0, 5; jal x0, +8
    {
        const { run, view } = compile([0x00500093, 0x0080006f]);
        const next = run(0, 256, 0);
        assert.strictEqual(view[1], 5n, 'x1 = 5');
        assert.strictEqual(next, 12, 'jal at pc=4 returns pc + imm');
    }

    // Block 2: bne x1, x2, +12 (not taken); addi x3, x0, 9
    {
        const { run, view } = compile([0x00209063, 0x00900193]);
        const next = run(0, 256, 0);
        assert.strictEqual(next, 8, 'branch not taken falls through');
        assert.strictEqual(view[3], 9n, 'x3 = 9');
    }

    // Block 3: beq x0, x0, +8 (taken); addi x4, x0, 7 should be skipped
    {
        const { run, view } = compile([0x00000463, 0x00700213]);
        const next = run(0, 256, 0);
        assert.strictEqual(next, 8, 'branch taken jumps over addi');
        assert.strictEqual(view[4], 0n, 'skipped instruction did not run');
    }

    // Block 4: addi x1, x0, 0; addi x2, x0, 123; sd x2, 0(x1); ld x3, 0(x1)
    {
        const { run, view, data } = compile([
            0x00000093,
            0x07b00113,
            0x0020b023,
            0x0000b183,
        ]);
        const next = run(0, 256, 0);
        assert.strictEqual(next, 16, 'load/store block falls through');
        assert.strictEqual(view[3], 123n, 'x3 loaded from memory');
        assert.strictEqual(data.getBigInt64(256, true), 123n, 'memory contains stored value');
    }

    // Block 5: OP-IMM-32 / OP-32
    {
        const { run, view } = compile([
            0x0010029b, // addiw x5, x0, 1
            0x0052833b, // addw  x6, x5, x5
            0x0023139b, // slliw x7, x6, 2
        ]);
        run(0, 256, 0);
        assert.strictEqual(view[5], 1n, 'x5 = 1');
        assert.strictEqual(view[6], 2n, 'x6 = 2');
        assert.strictEqual(view[7], 8n, 'x7 = 8');
    }

    console.log('JIT spike passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

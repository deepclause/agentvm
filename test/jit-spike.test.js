'use strict';

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

function assemble(...instructions) {
    return instructions.map((n) => n >>> 0);
}

async function main() {
    // addi x1, x0, 5
    // addi x2, x0, 7
    // add  x3, x1, x2
    // andi x4, x1, 0xff
    const instructions = assemble(
        0x00500093,
        0x00700113,
        0x002081b3,
        0x0ff0f213,
    );

    const jit = new RiscVBlockJit(instructions);
    const module = jit.compile();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { run } = new WebAssembly.Instance(module, { env: { memory } }).exports;

    const view = new BigInt64Array(memory.buffer);
    view[0] = 0n; // x0 stays zero
    run(0);

    assert.strictEqual(view[1], 5n, 'x1 = 5');
    assert.strictEqual(view[2], 7n, 'x2 = 7');
    assert.strictEqual(view[3], 12n, 'x3 = 12');
    assert.strictEqual(view[4], 5n, 'x4 = 5 & 0xff');
    assert.strictEqual(view[0], 0n, 'x0 must remain zero');

    console.log('JIT spike passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

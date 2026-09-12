'use strict';

const assert = require('node:assert');
const { expandCompressed, decodeRiscV } = require('../src/riscv-c');

function hex(n) {
    return `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
}

async function main() {
    const cases = [
        [0x4285, 0x00100293], // c.li x5, 1
        [0x0285, 0x00128293], // c.addi x5, x5, 1
        [0x929a, 0x006282b3], // c.add x5, x6
        [0x8082, 0x00008067], // c.jr x1
        [0x829a, 0x00030293], // c.mv x5, x6
    ];
    for (const [insn, expected] of cases) {
        const actual = expandCompressed(insn);
        assert.strictEqual(hex(actual), hex(expected), `expand ${hex(insn)}`);
    }

    // decodeRiscV: 16-bit compressed -> expanded word
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(0x4285, 0);
    buf.writeUInt32LE(0x00100293, 4);
    assert.deepStrictEqual(decodeRiscV(buf, 0), { word: 0x00100293, size: 2 });
    assert.deepStrictEqual(decodeRiscV(buf, 4), { word: 0x00100293, size: 4 });

    console.log('RISC-V C decoder tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

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
        // assembler-verified CA-format register ops and shift/andi
        [0x8d0d, 0x40b50533], // c.sub a0, a1
        [0x8d2d, 0x00b54533], // c.xor a0, a1
        [0x8d4d, 0x00b56533], // c.or a0, a1
        [0x8d6d, 0x00b57533], // c.and a0, a1
        [0x9d0d, 0x40b5053b], // c.subw a0, a1
        [0x9d2d, 0x00b5053b], // c.addw a0, a1
        [0x2515, 0x0055051b], // c.addiw a0, 5
        [0x1522, 0x02851513], // c.slli a0, 40
        [0x9121, 0x02855513], // c.srli a0, 40
        // assembler-verified SP-relative and immediate encodings
        [0x557e, 0x0fc12503], // c.lwsp a0, 252(sp)
        [0x757e, 0x1f813503], // c.ldsp a0, 504(sp)
        [0xdfaa, 0x0ea12e23], // c.swsp a0, 252(sp)
        [0xffaa, 0x1ea13c23], // c.sdsp a0, 504(sp)
        [0x1fe8, 0x3fc10513], // c.addi4spn a0, sp, 1020
        [0xdde8, 0x06a5ae23], // c.sw a0, 124(a1)
        [0xfde8, 0x0ea5bc23], // c.sd a0, 248(a1)
        [0x4498, 0x0084a703], // c.lw a0, 0(a1)
        // llvm-mc verified, asymmetric offsets: all-ones immediates above
        // cannot detect permuted offset fields.
        [0xf022, 0x02813023], // c.sdsp s0, 32(sp)
        [0xf406, 0x02113423], // c.sdsp ra, 40(sp)
        [0x69b8, 0x0505b703], // c.ld a4, 80(a1)
        [0xe13c, 0x04f53023], // c.sd a5, 64(a0)
        [0x60a6, 0x04813083], // c.ldsp ra, 72(sp)
        [0x4516, 0x04412503], // c.lwsp a0, 68(sp)
        [0xc32e, 0x08b12223], // c.swsp a1, 132(sp)
        [0x6144, 0x08053483], // c.ld s1, 128(a0)
    ];
    assert.strictEqual(hex(expandCompressed(0x0001)), hex(0x00000013), 'c.nop is addi x0, x0, 0');
    // Reserved encodings must not decode.
    assert.strictEqual(expandCompressed(0x6101), null, 'c.addi16sp 0 is reserved');
    assert.strictEqual(expandCompressed(0x6002), null, 'c.ldsp x0 is reserved');
    assert.strictEqual(expandCompressed(0x4002), null, 'c.lwsp x0 is reserved');
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

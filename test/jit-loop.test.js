'use strict';

const assert = require('node:assert');
const { RiscVBlockJit, decodeBlock } = require('../src/jit');

function encI(opcode, rd, rs1, funct3, imm) {
    return ((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode;
}

function encR(rd, rs1, rs2, funct3, funct7) {
    return (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | 0x33;
}

function encB(rs1, rs2, funct3, imm) {
    imm &= 0x1fff;
    return (
        (((imm >> 12) & 1) << 31) |
        (((imm >> 5) & 0x3f) << 25) |
        (rs2 << 20) |
        (rs1 << 15) |
        (funct3 << 12) |
        (((imm >> 1) & 0xf) << 8) |
        (((imm >> 11) & 1) << 7) |
        0x63
    );
}

async function main() {
    // sum = 0; for (i = 0; i < 1000; i++) sum += i
    const words = [
        encI(0x13, 5, 0, 0, 0),     // addi x5, x0, 0
        encI(0x13, 6, 0, 0, 1000),  // addi x6, x0, 1000
        encI(0x13, 7, 0, 0, 0),     // addi x7, x0, 0
        encR(7, 7, 5, 0, 0),        // loop: add x7, x7, x5
        encI(0x13, 5, 5, 0, 1),     // addi x5, x5, 1
        encB(5, 6, 4, 12 - 20),     // blt x5, x6, loop (pc 12)
    ];
    const code = Buffer.alloc(words.length * 4);
    words.forEach((w, i) => code.writeUInt32LE(w >>> 0, i * 4));

    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new BigInt64Array(memory.buffer);
    const cache = new Map();

    let pc = 0;
    let steps = 0;
    while (pc >= 0 && pc < code.length && steps++ < 2000) {
        const block = decodeBlock(code, pc);
        if (block.terminal === 'unsupported') break;
        let run = cache.get(pc);
        if (!run) {
            const module = new RiscVBlockJit(block.instructions, block.sizes).compile();
            run = new WebAssembly.Instance(module, { env: { memory } }).exports.run;
            cache.set(pc, run);
        }
        pc = Number(run(0, 256, BigInt(pc)));
    }

    assert.strictEqual(view[7], 499500n, 'sum(0..999)');
    assert.strictEqual(cache.size, 2, 'prologue and loop blocks are cached');

    // Compressed-instruction block: c.li x5,1; c.li x6,3; c.add x5,x6
    {
        const compressed = Buffer.from([0x85, 0x42, 0x0d, 0x43, 0x9a, 0x92]);
        const block = decodeBlock(compressed, 0);
        assert.strictEqual(block.sizes.join(','), '2,2,2');
        const module = new RiscVBlockJit(block.instructions, block.sizes).compile();
        const run = new WebAssembly.Instance(module, { env: { memory } }).exports.run;
        const regs2 = new BigInt64Array(memory.buffer, 0, 32);
        regs2.fill(0n);
        run(0, 256, 0n);
        assert.strictEqual(regs2[5], 4n, 'compressed add result');
        assert.strictEqual(regs2[6], 3n, 'compressed li result');
    }

    console.log(`JIT loop passed (${steps} steps, ${cache.size} cached blocks)`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

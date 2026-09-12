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
    const code = new Uint32Array(16);
    code[0] = encI(0x13, 5, 0, 0, 0);     // addi x5, x0, 0
    code[1] = encI(0x13, 6, 0, 0, 1000);  // addi x6, x0, 1000
    code[2] = encI(0x13, 7, 0, 0, 0);     // addi x7, x0, 0
    code[3] = encR(7, 7, 5, 0, 0);        // loop: add x7, x7, x5
    code[4] = encI(0x13, 5, 5, 0, 1);     // addi x5, x5, 1
    code[5] = encB(5, 6, 4, 12 - 20);     // blt x5, x6, loop (pc 12)

    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new BigInt64Array(memory.buffer);
    const cache = new Map();

    let pc = 0;
    let steps = 0;
    while (pc >= 0 && pc < code.length * 4 && steps++ < 2000) {
        const block = decodeBlock(code, pc);
        if (block.terminal === 'unsupported') break;
        let run = cache.get(pc);
        if (!run) {
            const module = new RiscVBlockJit(block.instructions).compile();
            run = new WebAssembly.Instance(module, { env: { memory } }).exports.run;
            cache.set(pc, run);
        }
        pc = run(0, 256, pc);
    }

    assert.strictEqual(view[7], 499500n, 'sum(0..999)');
    assert.strictEqual(cache.size, 2, 'prologue and loop blocks are cached');
    console.log(`JIT loop passed (${steps} steps, ${cache.size} cached blocks)`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

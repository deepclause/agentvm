'use strict';

// Targeted ALU tests, especially the RV64 *W shift opcodes where the low 32
// bits must be used as the shift source.

const assert = require('node:assert');
const { RiscVBlockJit } = require('../src/jit');

const REGS = 0x1000;

// OP-IMM / OP-IMM-32 / OP / OP-32 encoders
const immOp = (opcode, funct3, rd, rs1, imm) =>
    ((imm & 0xfff) << 20 | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
const regOp = (opcode, funct3, funct7, rd, rs1, rs2) =>
    ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;

function run(insns, init) {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const view = new DataView(memory.buffer);
    for (const [r, v] of Object.entries(init || {})) view.setBigUint64(REGS + Number(r) * 8, BigInt.asUintN(64, v), true);
    const module = new RiscVBlockJit(insns, null, { directTlb: true }).compile();
    // directTlb blocks only touch the TLB for memory ops; ALU-only blocks pass
    // null pointers and never dereference them.
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    instance.exports.run(REGS, 0, 0n, 0, 0);
    const regs = [];
    for (let i = 0; i < 32; i++) regs[i] = view.getBigInt64(REGS + i * 8, true);
    return regs;
}

let n = 0;
function eq(name, got, want) {
    assert.strictEqual(got, BigInt.asIntN(64, want), name);
    n++;
    console.log(`  PASS ${name}`);
}

// srliw x1, x2, 1  (low 32 bits only: 0x...00000001 >> 1 == 0)
eq('srliw uses low 32 bits', run([immOp(0x1b, 5, 1, 2, 1)], { 2: 0x100000001n })[1], 0n);
// srlw x1, x2, x3
eq('srlw uses low 32 bits', run([regOp(0x3b, 5, 0x00, 1, 2, 3)], { 2: 0x100000001n, 3: 1n })[1], 0n);
// sraiw x1, x2, 1 with bit 31 set -> arithmetic shift
eq('sraiw sign-fills', run([immOp(0x1b, 5, 1, 2, 0x401)], { 2: 0xffffffff80000000n })[1], -1073741824n);
// sraw x1, x2, x3
eq('sraw sign-fills', run([regOp(0x3b, 5, 0x20, 1, 2, 3)], { 2: 0xffffffff80000000n, 3: 1n })[1], -1073741824n);
// slliw x1, x2, 4 (ignores bits above 32, truncates/sign-extends the result)
eq('slliw uses low 32 bits', run([immOp(0x1b, 1, 1, 2, 4)], { 2: 0x100000001n })[1], 0x10n);
// slliw overflow wraps to 0 and stays positive
eq('slliw wraps at 32 bits', run([immOp(0x1b, 1, 1, 2, 1)], { 2: 0x80000000n })[1], 0n);
// addiw x1, x2, 1 wraps at 32 bits
eq('addiw wraps at 32 bits', run([immOp(0x1b, 0, 1, 2, 1)], { 2: 0x7fffffffn })[1], -2147483648n);
// addiw keeps low 32 bits of a wide input
eq('addiw truncates a wide input', run([immOp(0x1b, 0, 1, 2, 0)], { 2: 0x1_00000001n })[1], 1n);
// slli/srli/srai are full 64-bit
eq('slli shifts 64 bits', run([immOp(0x13, 1, 1, 2, 4)], { 2: 0x100000001n })[1], 0x1000000010n);
eq('srli shifts 64 bits', run([immOp(0x13, 5, 1, 2, 1)], { 2: 0x100000001n })[1], 0x80000000n);
// lui x1, 0x12345
const lui = ((0x12345 << 12) | (1 << 7) | 0x37) >>> 0;
eq('lui', run([lui], {})[1], 0x12345000n);
// x0 stays zero
eq('writes to x0 are discarded', run([immOp(0x13, 0, 0, 2, 5)], { 2: 7n })[0], 0n);
// signed vs unsigned set-less-than
eq('slt is signed', run([regOp(0x33, 2, 0, 1, 2, 3)], { 2: -1n, 3: 1n })[1], 1n);
eq('sltu is unsigned', run([regOp(0x33, 3, 0, 1, 2, 3)], { 2: -1n, 3: 1n })[1], 0n);

console.log(`ALU JIT: ${n} checks passed`);

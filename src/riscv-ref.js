'use strict';

// Independent reference interpreter for the JIT's supported integer subset.
// Used only by the AGENTVM_JIT_VERIFY differential check. It shares nothing
// with src/jit.js: it decodes the 32-bit word directly and models RISC-V
// semantics with explicit 64-bit wrapping.

const M64 = (1n << 64n) - 1n;
const sext = (v, bits) => BigInt.asIntN(bits, BigInt(v));
const wrap64 = (v) => BigInt.asIntN(64, v);

function memSizeWord(sizeLog2) { return 1 << sizeLog2; }

// Execute one instruction. Returns:
//   { next }            control transfer / fall-through PC
//   { fault: true }     access could not be serviced (caller bails)
//   undefined           continue to the next instruction
function step(insn, regs, mem, addr, size) {
    const opcode = insn & 0x7f;
    const rd = (insn >>> 7) & 0x1f;
    const rs1 = (insn >>> 15) & 0x1f;
    const rs2 = (insn >>> 20) & 0x1f;
    const funct3 = (insn >>> 12) & 7;
    const funct7 = (insn >>> 25) & 0x7f;
    const immI = sext((insn >>> 20) & 0xfff, 12);
    const immS = sext(((insn >>> 25) << 5) | ((insn >>> 7) & 0x1f), 12);
    const a = regs[rs1], b = regs[rs2];
    const set = (v) => { if (rd !== 0) regs[rd] = wrap64(v); };
    const w32 = (v) => BigInt.asIntN(32, v);

    switch (opcode) {
        case 0x13: // OP-IMM
            switch (funct3) {
                case 0: set(a + immI); break;
                case 1: set(a << (immI & 63n)); break;
                case 2: set(a < immI ? 1n : 0n); break;
                case 3: set(BigInt.asUintN(64, a) < BigInt.asUintN(64, immI) ? 1n : 0n); break;
                case 4: set(a ^ immI); break;
                case 5: set(((insn >>> 30) & 1) ? a >> (immI & 63n) : BigInt.asUintN(64, a) >> (immI & 63n)); break;
                case 6: set(a | immI); break;
                case 7: set(a & immI); break;
            }
            break;
        case 0x1b: { // OP-IMM-32
            const sh = immI & 0x1fn;
            switch (funct3) {
                case 0: set(sext(w32(a) + w32(immI), 32)); break;
                case 1: set(sext(w32(a) << sh, 32)); break;
                case 5: set(((insn >>> 30) & 1) ? sext(w32(a) >> sh, 32) : sext(BigInt.asUintN(32, a) >> sh, 32)); break;
            }
            break;
        }
        case 0x33: // OP
            switch (funct3) {
                case 0: set(funct7 === 0x20 ? a - b : a + b); break;
                case 1: set(a << (b & 63n)); break;
                case 2: set(a < b ? 1n : 0n); break;
                case 3: set(BigInt.asUintN(64, a) < BigInt.asUintN(64, b) ? 1n : 0n); break;
                case 4: set(a ^ b); break;
                case 5: set(funct7 === 0x20 ? a >> (b & 63n) : BigInt.asUintN(64, a) >> (b & 63n)); break;
                case 6: set(a | b); break;
                case 7: set(a & b); break;
            }
            break;
        case 0x3b: { // OP-32
            const sh = b & 0x1fn;
            switch (funct3) {
                case 0: set(sext(w32(funct7 === 0x20 ? a - b : a + b), 32)); break;
                case 1: set(sext(w32(a) << sh, 32)); break;
                case 5: set(funct7 === 0x20 ? sext(w32(a) >> sh, 32) : sext(BigInt.asUintN(32, a) >> sh, 32)); break;
            }
            break;
        }
        case 0x37: set(sext(insn & 0xfffff000, 32)); break; // LUI
        case 0x17: set(addr + sext(insn & 0xfffff000, 32)); break; // AUIPC
        case 0x03: { // LOAD
            const va = a + immI;
            const sizes = [1, 2, 4, 8, 1, 2, 4];
            const signed = funct3 <= 2 || funct3 === 3;
            const v = mem.read(va, sizes[funct3], signed);
            if (v === null) return { fault: true };
            if (funct3 === 3) set(v); else set(v);
            break;
        }
        case 0x23: { // STORE
            const va = a + immS;
            const sizes = [1, 2, 4, 8];
            if (!mem.write(va, sizes[funct3], b)) return { fault: true };
            break;
        }
        case 0x6f: { // JAL
            const imm = sext(
                (((insn >>> 31) & 1) << 20) | (((insn >>> 12) & 0xff) << 12) |
                (((insn >>> 20) & 1) << 11) | (((insn >>> 21) & 0x3ff) << 1), 21);
            set(addr + BigInt(size));
            return { next: addr + imm };
        }
        case 0x67: { // JALR
            const imm = immI;
            set(addr + BigInt(size));
            return { next: (a + imm) & ~1n };
        }
        case 0x63: { // BRANCH
            const imm = sext(
                (((insn >>> 31) & 1) << 12) | (((insn >>> 7) & 1) << 11) |
                (((insn >>> 25) & 0x3f) << 5) | (((insn >>> 8) & 0xf) << 1), 13);
            let take = false;
            switch (funct3) {
                case 0: take = a === b; break;
                case 1: take = a !== b; break;
                case 4: take = a < b; break;
                case 5: take = a >= b; break;
                case 6: take = BigInt.asUintN(64, a) < BigInt.asUintN(64, b); break;
                case 7: take = BigInt.asUintN(64, a) >= BigInt.asUintN(64, b); break;
            }
            if (take) return { next: addr + imm };
            break;
        }
        default:
            return { fault: true };
    }
    return undefined;
}

// Run a block from startPc. Returns { next } or { fault: true, pc }.
function run(insns, sizes, regs, mem, startPc) {
    let off = 0n;
    for (let i = 0; i < insns.length; i++) {
        const r = step(insns[i], regs, mem, startPc + off, sizes[i]);
        if (r) {
            if (r.fault) return { fault: true, pc: startPc + off };
            return { next: r.next };
        }
        off += BigInt(sizes[i]);
    }
    return { next: startPc + off };
}

module.exports = { run, M64 };

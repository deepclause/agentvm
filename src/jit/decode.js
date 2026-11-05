'use strict';

const { decodeRiscV } = require('../riscv-c');

const PAGE_SIZE = 4096;
const PAGE_MASK = PAGE_SIZE - 1;

function sext(value, bits) {
    const shift = 32 - bits;
    return (value << shift) >> shift;
}

function branchOffset(insn) {
    return sext(
        (((insn >>> 31) & 1) << 12) | (((insn >>> 7) & 1) << 11) |
        (((insn >>> 25) & 0x3f) << 5) | (((insn >>> 8) & 0xf) << 1), 13,
    );
}

function jalOffset(insn) {
    return sext(
        (((insn >>> 31) & 1) << 20) | (((insn >>> 12) & 0xff) << 12) |
        (((insn >>> 20) & 1) << 11) | (((insn >>> 21) & 0x3ff) << 1), 21,
    );
}

function immI(insn) {
    return sext(insn >>> 20, 12);
}

function immS(insn) {
    return sext(((insn >>> 25) << 5) | ((insn >>> 7) & 0x1f), 12);
}

function decodeAt(buffer, off) {
    if (off < 0 || off >= buffer.length) return null;
    if (off + 2 > buffer.length) return null;
    const first = buffer.readUInt16LE(off);
    if ((first & 3) !== 3) {
        const decoded = decodeRiscV(buffer, off);
        if (!decoded) return null;
        return { word: decoded.word >>> 0, size: 2, off };
    }
    if (off + 4 > buffer.length) return null;
    return { word: buffer.readUInt32LE(off) >>> 0, size: 4, off };
}

// Classify a decoded 32-bit instruction. The return value is intentionally
// small: the region builder only needs to know whether the instruction can be
// emitted, terminates the block, or must be executed by the interpreter.
function classify(insn) {
    const opcode = insn & 0x7f;
    const funct3 = (insn >>> 12) & 7;
    const funct7 = (insn >>> 25) & 0x7f;

    switch (opcode) {
        case 0x13: // OP-IMM
            // RV64 shifts use imm[5:0] as shamt, so funct7 (imm[11:5]) may be
            // 0x00/0x01 (SLLI/SRLI) or 0x20/0x21 (SRAI).
            if (funct3 === 1) return (funct7 === 0x00 || funct7 === 0x01) ? { kind: 'alu' } : { kind: 'unsupported' };
            if (funct3 === 5) return (funct7 === 0x00 || funct7 === 0x01 || funct7 === 0x20 || funct7 === 0x21)
                ? { kind: 'alu' } : { kind: 'unsupported' };
            if (funct3 === 0 || funct3 === 2 || funct3 === 3 || funct3 === 4 || funct3 === 6 || funct3 === 7)
                return { kind: 'alu' };
            return { kind: 'unsupported' };
        case 0x1b: // OP-IMM-32
            if (funct3 === 1) return funct7 === 0 ? { kind: 'alu' } : { kind: 'unsupported' }; // slliw
            if (funct3 === 5) return (funct7 === 0 || funct7 === 0x20) ? { kind: 'alu' } : { kind: 'unsupported' };
            if (funct3 === 0) return { kind: 'alu' };
            return { kind: 'unsupported' };
        case 0x33: // OP
            if (funct7 === 0x00) {
                if (funct3 <= 7) return { kind: 'alu' };
            } else if (funct7 === 0x20) {
                if (funct3 === 0 || funct3 === 5) return { kind: 'alu' };
            } else if (funct7 === 0x01) {
                // RV64M. mulh/mulhsu/mulhu use a wide multiply that the MVP
                // translator leaves to the interpreter.
                if (funct3 === 0 || (funct3 >= 4 && funct3 <= 7)) return { kind: 'alu' };
            }
            return { kind: 'unsupported' };
        case 0x3b: // OP-32
            if (funct7 === 0x00) {
                if (funct3 === 0 || funct3 === 1 || funct3 === 5) return { kind: 'alu' };
            } else if (funct7 === 0x20) {
                if (funct3 === 0 || funct3 === 5) return { kind: 'alu' };
            } else if (funct7 === 0x01) {
                if (funct3 === 0 || (funct3 >= 4 && funct3 <= 7)) return { kind: 'alu' };
            }
            return { kind: 'unsupported' };
        case 0x37: return { kind: 'lui' };
        case 0x17: return { kind: 'auipc' };
        case 0x03:
            if (funct3 <= 6) return { kind: 'load' };
            return { kind: 'unsupported' };
        case 0x23:
            if (funct3 <= 3) return { kind: 'store' };
            return { kind: 'unsupported' };
        case 0x63:
            if (funct3 === 2 || funct3 === 3) return { kind: 'unsupported' };
            return { kind: 'branch' };
        case 0x6f: return { kind: 'jal' };
        case 0x67: return { kind: 'jalr' };
        case 0x0f: // MISC-MEM
            if (funct3 === 0) {
                if (insn === 0x8330000f) return { kind: 'nop' }; // fence.tso
                if ((insn & 0xf00fff80) === 0) return { kind: 'nop' }; // fence
                return { kind: 'exit', reason: 'fence' };
            }
            return { kind: 'exit', reason: 'fence.i' };
        case 0x73: {
            // Pure CSR reads (csrrs/csrrc with rs1=x0, csrrsi/csrrci with
            // uimm=0) have no side effects and end in NEXT_INSN, so they run
            // through jit_step inside the region. Everything else (CSR
            // writes, ecall, xret, wfi, sfence.vma) ends the region.
            const rs1 = (insn >>> 15) & 0x1f;
            if ((funct3 & 3) >= 2 && rs1 === 0) return { kind: 'helper', reason: 'csr-read' };
            return { kind: 'exit', reason: 'system' };
        }
        // Rare classes run through jit_step inside the region. They do not
        // change control flow, so the block can continue afterwards.
        case 0x2f: return { kind: 'helper', reason: 'amo' };
        case 0x07: return { kind: 'helper', reason: 'fp-load' };
        case 0x27: return { kind: 'helper', reason: 'fp-store' };
        case 0x43:
        case 0x47:
        case 0x4b:
        case 0x4f:
        case 0x53: return { kind: 'helper', reason: 'fp' };
        default: return { kind: 'unsupported' };
    }
}

module.exports = {
    PAGE_SIZE, PAGE_MASK, sext, branchOffset, jalOffset, immI, immS,
    decodeAt, classify,
};

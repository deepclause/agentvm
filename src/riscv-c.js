'use strict';

// RISC-V C extension (16-bit compressed) decoder.
//
// `expandCompressed` converts one 16-bit compressed instruction into the
// equivalent 32-bit instruction so the existing 32-bit JIT decoder can consume
// it. Returns null for unsupported or reserved encodings.

function sext(value, bits) {
    const shift = 32 - bits;
    return (value << shift) >> shift;
}

function encI(rd, rs1, funct3, imm) {
    return (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | 0x13) >>> 0;
}
function encR(rd, rs1, rs2, funct3, funct7) {
    return ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | 0x33) >>> 0;
}
function encS(rs1, rs2, funct3, imm) {
    imm &= 0xfff;
    return ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
}
function encB(rs1, rs2, funct3, imm) {
    imm &= 0x1fff;
    return ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | 0x63) >>> 0;
}
function encJ(rd, imm) {
    imm &= 0x1fffff;
    return ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) | (rd << 7) | 0x6f) >>> 0;
}
function encJalr(rd, rs1, imm) {
    return (((imm & 0xfff) << 20) | (rs1 << 15) | (rd << 7) | 0x67) >>> 0;
}

function expandCompressed(insn) {
    const quadrant = insn & 3;
    const funct3 = (insn >> 13) & 7;

    if (quadrant === 0) {
        const rd1 = 8 + ((insn >> 2) & 7);
        const rs1 = 8 + ((insn >> 7) & 7);
        switch (funct3) {
            case 0: { // C.ADDI4SPN
                const imm = (((insn >> 12) & 3) << 4) | (((insn >> 7) & 0xf) << 6) | (((insn >> 5) & 1) << 3) | (((insn >> 6) & 1) << 2);
                if (imm === 0) return null;
                return encI(rd1, 2, 0, imm);
            }
            case 2: { // C.LW
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 6) | (((insn >> 6) & 1) << 2);
                return encI(rd1, rs1, 2, imm);
            }
            case 3: { // C.LD
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 7) | (((insn >> 6) & 1) << 6);
                return encI(rd1, rs1, 3, imm);
            }
            case 6: { // C.SW
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 6) | (((insn >> 6) & 1) << 2);
                return encS(rs1, rd1, 2, imm);
            }
            case 7: { // C.SD
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 7) | (((insn >> 6) & 1) << 6);
                return encS(rs1, rd1, 3, imm);
            }
            default:
                return null;
        }
    }

    if (quadrant === 1) {
        const rd = (insn >> 7) & 0x1f;
        const imm6 = sext(((insn >> 12) & 1) << 5 | ((insn >> 2) & 0x1f), 6);
        switch (funct3) {
            case 0: // C.NOP / C.ADDI
                return rd === 0 ? null : encI(rd, rd, 0, imm6);
            case 2: // C.LI
                return rd === 0 ? null : encI(rd, 0, 0, imm6);
            case 3: { // C.ADDI16SP / C.LUI
                if (rd === 2) {
                    const imm10 = sext(
                        (((insn >> 12) & 1) << 9) | (((insn >> 3) & 3) << 7) | (((insn >> 5) & 1) << 6) | (((insn >> 2) & 1) << 5) | (((insn >> 6) & 1) << 4),
                        10,
                    );
                    return encI(2, 2, 0, imm10);
                }
                if (rd === 0) return null;
                return (((imm6 & 0x3f) << 12) & 0xfffff000 | (rd << 7) | 0x37) >>> 0;
            }
            case 4: { // C.SRLI / C.SRAI / C.ANDI (bit12=0) and register ops (bit12=1)
                const bit12 = (insn >> 12) & 1;
                if (bit12 === 0) {
                    const rd1 = 8 + ((insn >> 7) & 7);
                    const shamt = ((insn >> 2) & 0x1f) | (((insn >> 12) & 1) << 5);
                    const sub = (insn >> 10) & 3;
                    if (sub === 0) return encI(rd1, rd1, 5, shamt); // srli
                    if (sub === 1) return encI(rd1, rd1, 5, 0x400 | shamt); // srai (funct7=0x20)
                    if (sub === 2) return encI(rd1, rd1, 7, imm6); // andi
                    return null;
                }
                const r1 = 8 + ((insn >> 7) & 7);
                const r2 = 8 + ((insn >> 2) & 7);
                const funct = (insn >> 5) & 3;
                if (funct === 0) return encR(r1, r1, r2, 0, 0x20); // sub
                if (funct === 1) return encR(r1, r1, r2, 4, 0);    // xor
                if (funct === 2) return encR(r1, r1, r2, 6, 0);    // or
                if (funct === 3) return encR(r1, r1, r2, 7, 0);    // and
                return null;
            }
            case 5: { // C.J
                const imm = sext(
                    (((insn >> 12) & 1) << 11) | (((insn >> 11) & 1) << 4) | (((insn >> 9) & 3) << 8) | (((insn >> 8) & 1) << 10) | (((insn >> 7) & 1) << 6) | (((insn >> 6) & 1) << 7) | (((insn >> 3) & 7) << 1) | (((insn >> 2) & 1) << 5),
                    12,
                );
                return encJ(0, imm);
            }
            case 6: { // C.BEQZ
                const rs1 = 8 + ((insn >> 7) & 7);
                const imm = sext(
                    (((insn >> 12) & 1) << 8) | (((insn >> 10) & 3) << 3) | (((insn >> 5) & 3) << 6) | (((insn >> 3) & 3) << 1) | (((insn >> 2) & 1) << 5),
                    9,
                );
                return encB(rs1, 0, 0, imm);
            }
            case 7: { // C.BNEZ
                const rs1 = 8 + ((insn >> 7) & 7);
                const imm = sext(
                    (((insn >> 12) & 1) << 8) | (((insn >> 10) & 3) << 3) | (((insn >> 5) & 3) << 6) | (((insn >> 3) & 3) << 1) | (((insn >> 2) & 1) << 5),
                    9,
                );
                return encB(rs1, 0, 1, imm);
            }
            default:
                return null;
        }
    }

    if (quadrant === 2) {
        const rd = (insn >> 7) & 0x1f;
        const rs2 = (insn >> 2) & 0x1f;
        switch (funct3) {
            case 0: { // C.SLLI
                const shamt = ((insn >> 2) & 0x1f) | (((insn >> 12) & 1) << 5);
                return encI(rd, rd, 1, shamt);
            }
            case 2: { // C.LWSP
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 4) & 7) << 6) | (((insn >> 2) & 3) << 2);
                return encI(rd, 2, 2, imm);
            }
            case 3: { // C.LDSP
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 4) & 7) << 6) | (((insn >> 2) & 3) << 3);
                return encI(rd, 2, 3, imm);
            }
            case 4: { // C.JR / C.MV / C.EBREAK / C.JALR / C.ADD
                const bit12 = (insn >> 12) & 1;
                const rs1 = (insn >> 7) & 0x1f;
                if (bit12 === 0) {
                    if (rs2 === 0 && rs1 !== 0) return encJalr(0, rs1, 0); // C.JR
                    if (rs2 === 0 && rs1 === 0) return null;                // C.EBREAK
                    if (rs2 !== 0 && rs1 !== 0) return encI(rs1, rs2, 0, 0); // C.MV
                    return null;
                }
                if (rs2 === 0 && rs1 !== 0) return encJalr(1, rs1, 0); // C.JALR
                if (rs2 !== 0 && rs1 !== 0) return encR(rs1, rs1, rs2, 0, 0); // C.ADD
                return null;
            }
            case 6: { // C.SWSP
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 7) & 7) << 6) | (((insn >> 9) & 3) << 2);
                return encS(2, rs2, 2, imm);
            }
            case 7: { // C.SDSP
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 7) & 7) << 6) | (((insn >> 9) & 3) << 3);
                return encS(2, rs2, 3, imm);
            }
            default:
                return null;
        }
    }

    return null;
}

// Decode one variable-length instruction from a byte buffer. Returns
// { word, size } where word is a 32-bit instruction (compressed expanded).
function decodeRiscV(buffer, offset) {
    const first = buffer.readUInt16LE(offset);
    if ((first & 3) !== 3) {
        const word = expandCompressed(first);
        return word === null ? null : { word, size: 2 };
    }
    return { word: buffer.readUInt32LE(offset), size: 4 };
}

module.exports = { expandCompressed, decodeRiscV, sext };

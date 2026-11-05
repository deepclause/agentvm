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

function encI(rd, rs1, funct3, imm, opcode = 0x13) {
    return (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
}
function encR(rd, rs1, rs2, funct3, funct7, opcode = 0x33) {
    return ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
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
            case 0: { // C.ADDI4SPN (imm[5:4]=inst[12:11], imm[9:6]=inst[10:7], imm[3]=inst[5], imm[2]=inst[6])
                const imm = (((insn >> 11) & 3) << 4) | (((insn >> 7) & 0xf) << 6) | (((insn >> 5) & 1) << 3) | (((insn >> 6) & 1) << 2);
                if (imm === 0) return null;
                return encI(rd1, 2, 0, imm);
            }
            case 2: { // C.LW
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 6) | (((insn >> 6) & 1) << 2);
                return encI(rd1, rs1, 2, imm, 0x03);
            }
            case 3: { // C.LD (uimm[5:3]=inst[12:10], uimm[7:6]=inst[6:5])
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 3) << 6);
                return encI(rd1, rs1, 3, imm, 0x03);
            }
            case 6: { // C.SW
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 1) << 6) | (((insn >> 6) & 1) << 2);
                return encS(rs1, rd1, 2, imm);
            }
            case 7: { // C.SD (uimm[5:3]=inst[12:10], uimm[7:6]=inst[6:5])
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 5) & 3) << 6);
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
            case 0: // C.NOP / C.ADDI (rd=x0 forms are hints: nop)
                return rd === 0 ? encI(0, 0, 0, 0) : encI(rd, rd, 0, imm6);
            case 1: // C.ADDIW (RV64)
                return rd === 0 ? null : encI(rd, rd, 0, imm6, 0x1b);
            case 2: // C.LI
                return rd === 0 ? null : encI(rd, 0, 0, imm6);
            case 3: { // C.ADDI16SP / C.LUI
                if (rd === 2) {
                    const imm10 = sext(
                        (((insn >> 12) & 1) << 9) | (((insn >> 3) & 3) << 7) | (((insn >> 5) & 1) << 6) | (((insn >> 2) & 1) << 5) | (((insn >> 6) & 1) << 4),
                        10,
                    );
                    if (imm10 === 0) return null; // reserved
                    return encI(2, 2, 0, imm10);
                }
                if (rd === 0) return null;
                return ((imm6 << 12) | (rd << 7) | 0x37) >>> 0;
            }
            case 4: { // shifts/andi (bits[11:10]!=11) and register ops (bits[11:10]==11)
                const sub = (insn >> 10) & 3;
                if (sub !== 3) {
                    const rd1 = 8 + ((insn >> 7) & 7);
                    const shamt = ((insn >> 2) & 0x1f) | (((insn >> 12) & 1) << 5);
                    if (sub === 0) return encI(rd1, rd1, 5, shamt);            // srli
                    if (sub === 1) return encI(rd1, rd1, 5, 0x400 | shamt);    // srai
                    return encI(rd1, rd1, 7, sext(shamt, 6));                  // andi
                }
                const r1 = 8 + ((insn >> 7) & 7);
                const r2 = 8 + ((insn >> 2) & 7);
                const funct2 = (insn >> 5) & 3;
                const is32 = (insn >> 12) & 1;
                if (!is32) {
                    if (funct2 === 0) return encR(r1, r1, r2, 0, 0x20); // sub
                    if (funct2 === 1) return encR(r1, r1, r2, 4, 0);    // xor
                    if (funct2 === 2) return encR(r1, r1, r2, 6, 0);    // or
                    return encR(r1, r1, r2, 7, 0);                       // and
                }
                if (funct2 === 0) return encR(r1, r1, r2, 0, 0x20, 0x3b); // subw
                if (funct2 === 1) return encR(r1, r1, r2, 0, 0x00, 0x3b); // addw
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
            case 2: { // C.LWSP (uimm[5]=inst[12], uimm[4:2]=inst[6:4], uimm[7:6]=inst[3:2])
                if (rd === 0) return null;
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 4) & 7) << 2) | (((insn >> 2) & 3) << 6);
                return encI(rd, 2, 2, imm, 0x03);
            }
            case 3: { // C.LDSP (uimm[5]=inst[12], uimm[4:3]=inst[6:5], uimm[8:6]=inst[4:2])
                if (rd === 0) return null;
                const imm = (((insn >> 12) & 1) << 5) | (((insn >> 5) & 3) << 3) | (((insn >> 2) & 7) << 6);
                return encI(rd, 2, 3, imm, 0x03);
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
            case 6: { // C.SWSP (uimm[5:2]=inst[12:9], uimm[7:6]=inst[8:7])
                const imm = (((insn >> 9) & 0xf) << 2) | (((insn >> 7) & 3) << 6);
                return encS(2, rs2, 2, imm);
            }
            case 7: { // C.SDSP (uimm[5:3]=inst[12:10], uimm[8:6]=inst[9:7])
                const imm = (((insn >> 10) & 7) << 3) | (((insn >> 7) & 7) << 6);
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

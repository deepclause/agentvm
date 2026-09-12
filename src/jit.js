'use strict';

// Minimal RISC-V (RV64) integer block translator -> WebAssembly.
//
// This is the first JIT milestone. It translates straight-line sequences of
// integer ALU instructions into a single WASM function that operates on a
// 32 x i64 register file in linear memory. Memory operations, branches, MMU,
// traps, and interrupts are not yet handled; those are the next integration
// steps into TinyEMU.

function u32leb(value) {
    const out = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        out.push(byte);
    } while (value !== 0);
    return Buffer.from(out);
}

function s32leb(value) {
    const out = [];
    let more = true;
    while (more) {
        let byte = value & 0x7f;
        value >>= 7;
        if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out.push(byte);
    }
    return Buffer.from(out);
}

function s64leb(value) {
    const out = [];
    let more = true;
    let v = BigInt.asIntN(64, BigInt(value));
    while (more) {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out.push(byte);
    }
    return Buffer.from(out);
}

function section(id, contents) {
    return Buffer.concat([Buffer.from([id]), u32leb(contents.length), contents]);
}

function stringBytes(str) {
    const bytes = Buffer.from(str, 'utf8');
    return Buffer.concat([u32leb(bytes.length), bytes]);
}

function sext(value, bits) {
    const shift = 32 - bits;
    return (value << shift) >> shift;
}

class RiscVBlockJit {
    constructor(instructions) {
        this.instructions = instructions;
    }

    compile() {
        const body = this._emitBody();
        const codeSection = section(10, Buffer.concat([
            u32leb(1),               // one function body
            u32leb(body.length),
            body,
        ]));

        const typeSection = section(1, Buffer.concat([
            u32leb(1),               // one type
            Buffer.from([0x60]),     // func
            u32leb(1), Buffer.from([0x7f]), // one i32 param (register base)
            u32leb(1), Buffer.from([0x7f]), // one i32 result (always 0)
        ]));

        const importSection = section(2, Buffer.concat([
            u32leb(1),
            stringBytes('env'),
            stringBytes('memory'),
            Buffer.from([0x02, 0x00, 0x01]), // memory, min 1 page
        ]));

        const functionSection = section(3, Buffer.concat([
            u32leb(1),
            u32leb(0),
        ]));

        const exportSection = section(7, Buffer.concat([
            u32leb(1),
            stringBytes('run'),
            Buffer.from([0x00]),     // function
            u32leb(0),
        ]));

        const binary = Buffer.concat([
            Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
            typeSection,
            importSection,
            functionSection,
            exportSection,
            codeSection,
        ]);

        return new WebAssembly.Module(binary);
    }

    _emitBody() {
        const out = [];
        out.push(Buffer.from([0x00])); // zero locals

        for (const insn of this.instructions) {
            this._emitInstruction(out, insn);
        }

        out.push(Buffer.from([0x41, 0x00])); // i32.const 0
        out.push(Buffer.from([0x0b]));       // end
        return Buffer.concat(out);
    }

    _regAddr(out, reg) {
        out.push(Buffer.from([0x20, 0x00]));       // local.get 0 (regs base)
        out.push(Buffer.from([0x41]));             // i32.const
        out.push(s32leb(reg * 8));
        out.push(Buffer.from([0x6a]));             // i32.add
    }

    _loadReg(out, reg) {
        this._regAddr(out, reg);
        out.push(Buffer.from([0x29, 0x03, 0x00])); // i64.load align=3 offset=0
    }

    _beginStore(out, reg) {
        this._regAddr(out, reg);
    }

    _endStore(out) {
        out.push(Buffer.from([0x37, 0x03, 0x00])); // i64.store align=3 offset=0
    }

    _const64(out, value) {
        out.push(Buffer.from([0x42])); // i64.const
        out.push(s64leb(value));
    }

    _emitBinary(out, opcode, rd, rs1, rs2) {
        this._beginStore(out, rd);
        this._loadReg(out, rs1);
        this._loadReg(out, rs2);
        out.push(Buffer.from([opcode]));
        this._endStore(out);
    }

    _emitBinaryImm(out, opcode, rd, rs1, imm) {
        this._beginStore(out, rd);
        this._loadReg(out, rs1);
        this._const64(out, imm);
        out.push(Buffer.from([opcode]));
        this._endStore(out);
    }

    _emitInstruction(out, insn) {
        const opcode = insn & 0x7f;
        const rd = (insn >>> 7) & 0x1f;
        const rs1 = (insn >>> 15) & 0x1f;
        const rs2 = (insn >>> 20) & 0x1f;
        const funct3 = (insn >>> 12) & 7;
        const funct7 = (insn >>> 25) & 0x7f;
        const immI = sext((insn >>> 20) & 0xfff, 12);

        switch (opcode) {
            case 0x13: { // OP-IMM
                switch (funct3) {
                    case 0: this._emitBinaryImm(out, 0x7c, rd, rs1, immI); break; // addi
                    case 4: this._emitBinaryImm(out, 0x85, rd, rs1, immI); break; // xori
                    case 6: this._emitBinaryImm(out, 0x84, rd, rs1, immI); break; // ori
                    case 7: this._emitBinaryImm(out, 0x83, rd, rs1, immI); break; // andi
                    case 2: this._emitBinaryImm(out, 0x53, rd, rs1, immI); break; // slti (i64.lt_s)
                    case 3: this._emitBinaryImm(out, 0x54, rd, rs1, immI); break; // sltiu (i64.lt_u)
                    case 1: { // slli
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI & 0x3f);
                        out.push(Buffer.from([0x86])); // i64.shl
                        this._endStore(out);
                        break;
                    }
                    case 5: {
                        const isArithmetic = (insn >>> 26) === 0x10;
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI & 0x3f);
                        out.push(Buffer.from([isArithmetic ? 0x87 : 0x88])); // i64.shr_s / shr_u
                        this._endStore(out);
                        break;
                    }
                    default:
                        throw new Error(`unsupported OP-IMM funct3=${funct3}`);
                }
                break;
            }
            case 0x33: { // OP
                switch (funct3) {
                    case 0: this._emitBinary(out, funct7 === 0x20 ? 0x7d : 0x7c, rd, rs1, rs2); break; // add/sub
                    case 1: this._emitBinary(out, 0x86, rd, rs1, rs2); break; // sll
                    case 2: this._emitBinary(out, 0x53, rd, rs1, rs2); break; // slt
                    case 3: this._emitBinary(out, 0x54, rd, rs1, rs2); break; // sltu
                    case 4: this._emitBinary(out, 0x85, rd, rs1, rs2); break; // xor
                    case 5: this._emitBinary(out, funct7 === 0x20 ? 0x87 : 0x88, rd, rs1, rs2); break; // srl/sra
                    case 6: this._emitBinary(out, 0x84, rd, rs1, rs2); break; // or
                    case 7: this._emitBinary(out, 0x83, rd, rs1, rs2); break; // and
                    default:
                        throw new Error(`unsupported OP funct3=${funct3}`);
                }
                break;
            }
            case 0x37: { // LUI
                this._beginStore(out, rd);
                this._const64(out, sext(insn & 0xfffff000, 32));
                this._endStore(out);
                break;
            }
            case 0x17: { // AUIPC (no PC tracking yet; treated as imm)
                this._beginStore(out, rd);
                this._const64(out, sext(insn & 0xfffff000, 32));
                this._endStore(out);
                break;
            }
            default:
                throw new Error(`unsupported opcode 0x${opcode.toString(16)}`);
        }
    }
}

module.exports = { RiscVBlockJit, u32leb, s32leb, s64leb, sext };

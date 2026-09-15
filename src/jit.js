'use strict';

const { decodeRiscV } = require('./riscv-c');

// High bit of the i64 returned by a direct-TLB block means "bail at this PC".
// The low 63 bits are the guest PC to resume the interpreter at.
const BAIL_BIT = -(1n << 63n);
const BAIL_MASK = (1n << 63n) - 1n;

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
    constructor(instructions, sizes = null, options = {}) {
        this.instructions = instructions;
        this.sizes = sizes || instructions.map(() => 4);
        this.externalMemory = !!options.externalMemory;
        // directTlb: import the emulator's linear memory and do guest accesses
        // by checking TinyEMU's TLB in generated WASM. This avoids a JS
        // callback per load/store, which is what makes the JS-callback mode
        // unusable. Params: (regs, tlbRead, pc:i64, statePtr, tlbWrite).
        this.directTlb = !!options.directTlb;
    }

    _typeSection() {
        const parts = [];
        let runParams;
        if (this.directTlb) {
            runParams = [0x7f, 0x7f, 0x7e, 0x7f, 0x7f]; // regs, tlbRead, pc(i64), statePtr, tlbWrite
        } else if (this.externalMemory) {
            runParams = [0x7f, 0x7f, 0x7e, 0x7f]; // regs, mem, pc(i64), statePtr
        } else {
            runParams = [0x7f, 0x7f, 0x7e];
        }
        parts.push(Buffer.concat([
            Buffer.from([0x60]), u32leb(runParams.length), Buffer.from(runParams),
            u32leb(1), Buffer.from([0x7e]),
        ]));
        if (this.externalMemory) {
            parts.push(Buffer.concat([
                Buffer.from([0x60]),
                u32leb(3), Buffer.from([0x7f, 0x7e, 0x7f]), // load(statePtr, addr, size)
                u32leb(1), Buffer.from([0x7e]),
            ]));
            parts.push(Buffer.concat([
                Buffer.from([0x60]),
                u32leb(4), Buffer.from([0x7f, 0x7e, 0x7f, 0x7e]), // store(statePtr, addr, size, val)
                u32leb(1), Buffer.from([0x7f]),
            ]));
        }
        return section(1, Buffer.concat([u32leb(parts.length), ...parts]));
    }

    _importSection() {
        const envMemory = Buffer.concat([
            stringBytes('env'),
            stringBytes('memory'),
            Buffer.from([0x02, 0x00, 0x01]), // memory, min 1 page
        ]);
        if (!this.externalMemory) {
            return section(2, Buffer.concat([u32leb(1), envMemory]));
        }
        const fn = (mod, name, type) => Buffer.concat([
            stringBytes(mod), stringBytes(name), Buffer.from([0x00]), u32leb(type),
        ]);
        return section(2, Buffer.concat([
            u32leb(3),
            envMemory,
            fn('env', 'load', 1),
            fn('env', 'store', 2),
        ]));
    }

    _buildModule(functions, exportNames) {
        const typeSection = this._typeSection();
        const importSection = this._importSection();

        const functionSection = section(3, Buffer.concat([
            u32leb(functions.length),
            ...functions.map(() => u32leb(0)),
        ]));

        // Imported functions occupy indices before defined functions.
        const functionIndexBase = this.externalMemory ? 2 : 0;
        const exportParts = [u32leb(functions.length)];
        functions.forEach((_, i) => {
            exportParts.push(stringBytes(exportNames[i] || `run_${i}`));
            exportParts.push(Buffer.from([0x00])); // function
            exportParts.push(u32leb(functionIndexBase + i));
        });
        const exportSection = section(7, Buffer.concat(exportParts));

        const codeParts = [u32leb(functions.length)];
        for (const body of functions) {
            codeParts.push(u32leb(body.length));
            codeParts.push(body);
        }
        const codeSection = section(10, Buffer.concat(codeParts));

        return Buffer.concat([
            Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
            typeSection,
            importSection,
            functionSection,
            exportSection,
            codeSection,
        ]);
    }

    compile() {
        const body = this._emitBody(this.instructions, this.sizes);
        return new WebAssembly.Module(this._buildModule([body], ['run']));
    }

    // Compile many blocks into one module with exports run_0, run_1, ...
    static compileMany(blocks, options = {}) {
        return new WebAssembly.Module(RiscVBlockJit.compileManyBytes(blocks, options));
    }

    static compileManyBytes(blocks, options = {}) {
        const instance = new RiscVBlockJit([], [], options);
        const bodies = blocks.map((block) => instance._emitBody(block.instructions, block.sizes));
        return instance._buildModule(bodies, blocks.map((_, i) => `run_${i}`));
    }

    _emitBody(instructions, sizes) {
        const out = [];
        if (this.directTlb) {
            // locals 5 = vaddr (i64), 6 = TLB entry address (i32), 7 = val (i64)
            out.push(Buffer.from([0x03, 0x01, 0x7e, 0x01, 0x7f, 0x01, 0x7e]));
        } else {
            out.push(Buffer.from([0x00])); // zero locals
        }

        let pc = 0;
        for (let i = 0; i < instructions.length; i++) {
            this._emitInstruction(out, instructions[i], pc, sizes[i]);
            pc += sizes[i];
        }

        // Fall through: return startPc + 4 * instruction count.
        out.push(Buffer.from([0x20, 0x02])); // local.get 2 (start pc, i64)
        this._const64(out, pc);
        out.push(Buffer.from([0x7c])); // i64.add
        out.push(Buffer.from([0x0f])); // return
        out.push(Buffer.from([0x0b])); // end
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

    _endStore(out, reg) {
        if (reg === 0) {
            // Writes to x0 are discarded; drop both address and value.
            out.push(Buffer.from([0x1a, 0x1a]));
        } else {
            out.push(Buffer.from([0x37, 0x03, 0x00])); // i64.store align=3 offset=0
        }
    }

    _const64(out, value) {
        out.push(Buffer.from([0x42])); // i64.const
        out.push(s64leb(value));
    }

    _emitBinary(out, opcode, rd, rs1, rs2, extendU32 = false) {
        this._beginStore(out, rd);
        this._loadReg(out, rs1);
        this._loadReg(out, rs2);
        out.push(Buffer.from([opcode]));
        if (extendU32) out.push(Buffer.from([0xad])); // i64.extend_i32_u
        this._endStore(out, rd);
    }

    _emitBinaryImm(out, opcode, rd, rs1, imm, extendU32 = false) {
        this._beginStore(out, rd);
        this._loadReg(out, rs1);
        this._const64(out, imm);
        out.push(Buffer.from([opcode]));
        if (extendU32) out.push(Buffer.from([0xad])); // i64.extend_i32_u
        this._endStore(out, rd);
    }

    // Sign-extend the low 32 bits of the current i64 value.
    _emitSignExtend32(out) {
        out.push(Buffer.from([0xa7])); // i32.wrap_i64
        out.push(Buffer.from([0xac])); // i64.extend_i32_s
    }

    // Zero-extend the low 32 bits of the current i64 value. This is needed
    // before a *32-bit logical/arithmetic right shift: shifting the full 64-bit
    // register would shift high bits into the low 32.
    _emitZeroExtend32(out) {
        out.push(Buffer.from([0xa7])); // i32.wrap_i64
        out.push(Buffer.from([0xad])); // i64.extend_i32_u
    }

    // Return startPc + offset. startPc is local 2.
    _emitReturnRel(out, offset) {
        out.push(Buffer.from([0x20, 0x02])); // local.get 2 (start pc, i64)
        this._const64(out, offset);
        out.push(Buffer.from([0x7c])); // i64.add
        out.push(Buffer.from([0x0f])); // return
    }

    // Push (startPc + offset) as i64.
    _emitPcConst(out, offset) {
        out.push(Buffer.from([0x20, 0x02])); // local.get 2 (i64)
        this._const64(out, offset);
        out.push(Buffer.from([0x7c])); // i64.add
    }

    _emitConditionalBranch(out, opcode, rs1, rs2, target) {
        this._loadReg(out, rs1);
        this._loadReg(out, rs2);
        out.push(Buffer.from([opcode])); // i64 comparison -> i32
        out.push(Buffer.from([0x04, 0x40])); // if (empty block type)
        this._emitReturnRel(out, target);
        out.push(Buffer.from([0x0b])); // end if
    }

    _emitAddress(out, rs1, imm) {
        // (memBase + (rs1 + imm)) as i32, truncated to 32 bits.
        out.push(Buffer.from([0x20, 0x01])); // local.get 1 (mem base)
        this._loadReg(out, rs1);
        this._const64(out, imm);
        out.push(Buffer.from([0x7c])); // i64.add
        out.push(Buffer.from([0xa7])); // i32.wrap_i64
        out.push(Buffer.from([0x6a])); // i32.add
    }

    // --- direct-TLB memory model (see constructor comment) ----------------
    // vaddr = reg[rs1] + imm (i64, local 5)
    // entry = tlb<tlbLocal> + ((vaddr >> 12) & 255) * 16 (i32, local 6)
    // tlbLocal is 1 (read) for loads and 4 (write) for stores, so a store
    // always re-checks the write TLB and cannot bypass write protection.
    _emitTlbEntry(out, rs1, imm, tlbLocal) {
        this._loadReg(out, rs1);
        if (imm) {
            this._const64(out, imm);
            out.push(Buffer.from([0x7c])); // i64.add
        }
        out.push(Buffer.from([0x21, 0x05])); // local.set 5
        out.push(Buffer.from([0x20, 0x05])); // local.get 5
        this._const64(out, 12n);
        out.push(Buffer.from([0x88])); // i64.shr_u
        this._const64(out, 255n);
        out.push(Buffer.from([0x83])); // i64.and
        out.push(Buffer.from([0xa7])); // i32.wrap_i64
        out.push(Buffer.from([0x41]));
        out.push(s32leb(4));
        out.push(Buffer.from([0x74])); // i32.shl  (idx * 16)
        out.push(Buffer.from([0x20, tlbLocal])); // local.get tlb ptr
        out.push(Buffer.from([0x6a])); // i32.add
        out.push(Buffer.from([0x21, 0x06])); // local.set 6
    }

    // i64.load(entry) == (vaddr & mask), where mask allows the low size-1 bits.
    _emitTlbHit(out, size) {
        out.push(Buffer.from([0x20, 0x06]));
        out.push(Buffer.from([0x29, 0x03, 0x00])); // i64.load
        out.push(Buffer.from([0x20, 0x05]));
        this._const64(out, BigInt(-4096 + (size - 1)));
        out.push(Buffer.from([0x83])); // i64.and
        out.push(Buffer.from([0x51])); // i64.eq
    }

    // host = i32.wrap(vaddr) + i32.load(entry + 8)
    _emitHostAddr(out) {
        out.push(Buffer.from([0x20, 0x05]));
        out.push(Buffer.from([0xa7])); // i32.wrap_i64
        out.push(Buffer.from([0x20, 0x06]));
        out.push(Buffer.from([0x28, 0x02, 0x08])); // i32.load offset=8
        out.push(Buffer.from([0x6a])); // i32.add
    }

    // Bail out of the block: return (startPc + offset) with the high bit set.
    // The host hands control back to the interpreter at that exact PC; all
    // earlier instructions have already committed, so this is precise.
    _emitBail(out, offset) {
        out.push(Buffer.from([0x20, 0x02])); // local.get 2 (start pc)
        this._const64(out, offset);
        out.push(Buffer.from([0x7c])); // i64.add
        this._const64(out, BAIL_BIT);
        out.push(Buffer.from([0x84])); // i64.or
        out.push(Buffer.from([0x0f])); // return
    }

    _emitLoad(out, rd, rs1, imm, opcode, size, pc = 0) {
        if (this.directTlb) {
            this._beginStore(out, rd);
            this._emitTlbEntry(out, rs1, imm, 1);
            this._emitTlbHit(out, size);
            out.push(Buffer.from([0x04, 0x40])); // if (void)
            this._emitHostAddr(out);
            out.push(Buffer.from([opcode, 0x00, 0x00])); // direct load
            out.push(Buffer.from([0x21, 0x07])); // local.set 7 (val)
            out.push(Buffer.from([0x05])); // else
            this._emitBail(out, pc);
            out.push(Buffer.from([0x0b])); // end if
            out.push(Buffer.from([0x20, 0x07])); // local.get 7 (val)
            this._endStore(out, rd);
            return;
        }
        if (this.externalMemory) {
            this._beginStore(out, rd);
            out.push(Buffer.from([0x20, 0x03])); // local.get 3 (statePtr)
            this._loadReg(out, rs1);
            this._const64(out, imm);
            out.push(Buffer.from([0x7c])); // i64.add
            out.push(Buffer.from([0x41])); // i32.const size
            out.push(s32leb(size));
            out.push(Buffer.from([0x10, 0x00])); // call 0 (env.load)
            this._endStore(out, rd);
            return;
        }
        this._beginStore(out, rd);
        this._emitAddress(out, rs1, imm);
        out.push(Buffer.from([opcode, 0x00, 0x00])); // load, align=0 offset=0
        this._endStore(out, rd);
    }

    _emitStore(out, rs1, rs2, imm, opcode, size, pc = 0) {
        if (this.directTlb) {
            this._emitTlbEntry(out, rs1, imm, 4);
            this._emitTlbHit(out, size);
            out.push(Buffer.from([0x04, 0x40])); // if (void)
            this._emitHostAddr(out);
            this._loadReg(out, rs2);
            out.push(Buffer.from([opcode, 0x00, 0x00])); // direct store
            out.push(Buffer.from([0x05])); // else
            this._emitBail(out, pc);
            out.push(Buffer.from([0x0b])); // end if
            return;
        }
        if (this.externalMemory) {
            out.push(Buffer.from([0x20, 0x03])); // local.get 3 (statePtr)
            this._loadReg(out, rs1);
            this._const64(out, imm);
            out.push(Buffer.from([0x7c])); // i64.add
            out.push(Buffer.from([0x41])); // i32.const size
            out.push(s32leb(size));
            this._loadReg(out, rs2);
            out.push(Buffer.from([0x10, 0x01])); // call 1 (env.store)
            out.push(Buffer.from([0x1a]));       // drop result
            return;
        }
        this._emitAddress(out, rs1, imm);
        this._loadReg(out, rs2);
        out.push(Buffer.from([opcode, 0x00, 0x00])); // store, align=0 offset=0
    }

    _emitInstruction(out, insn, pc, size = 4) {
        const opcode = insn & 0x7f;
        const rd = (insn >>> 7) & 0x1f;
        const rs1 = (insn >>> 15) & 0x1f;
        const rs2 = (insn >>> 20) & 0x1f;
        const funct3 = (insn >>> 12) & 7;
        const funct7 = (insn >>> 25) & 0x7f;
        const immI = sext((insn >>> 20) & 0xfff, 12);
        const immS = sext(((insn >>> 25) << 5) | ((insn >>> 7) & 0x1f), 12);

        switch (opcode) {
            case 0x13: { // OP-IMM
                switch (funct3) {
                    case 0: this._emitBinaryImm(out, 0x7c, rd, rs1, immI); break; // addi
                    case 4: this._emitBinaryImm(out, 0x85, rd, rs1, immI); break; // xori
                    case 6: this._emitBinaryImm(out, 0x84, rd, rs1, immI); break; // ori
                    case 7: this._emitBinaryImm(out, 0x83, rd, rs1, immI); break; // andi
                    case 2: this._emitBinaryImm(out, 0x53, rd, rs1, immI, true); break; // slti (i64.lt_s)
                    case 3: this._emitBinaryImm(out, 0x54, rd, rs1, immI, true); break; // sltiu (i64.lt_u)
                    case 1: { // slli
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI & 0x3f);
                        out.push(Buffer.from([0x86])); // i64.shl
                        this._endStore(out, rd);
                        break;
                    }
                    case 5: {
                        const isArithmetic = (insn >>> 26) === 0x10;
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI & 0x3f);
                        out.push(Buffer.from([isArithmetic ? 0x87 : 0x88])); // i64.shr_s / shr_u
                        this._endStore(out, rd);
                        break;
                    }
                    default:
                        throw new Error(`unsupported OP-IMM funct3=${funct3}`);
                }
                break;
            }
            case 0x1b: { // OP-IMM-32
                switch (funct3) {
                    case 0: { // ADDIW
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI);
                        out.push(Buffer.from([0x7c])); // i64.add
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    case 1: { // SLLIW
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._const64(out, immI & 0x1f);
                        out.push(Buffer.from([0x86])); // i64.shl
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    case 5: { // SRLIW / SRAIW
                        const isArithmetic = (insn >>> 30) & 1;
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        if (isArithmetic) this._emitSignExtend32(out);
                        else this._emitZeroExtend32(out);
                        this._const64(out, immI & 0x1f);
                        out.push(Buffer.from([isArithmetic ? 0x87 : 0x88]));
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    default:
                        throw new Error(`unsupported OP-IMM-32 funct3=${funct3}`);
                }
                break;
            }
            case 0x3b: { // OP-32
                switch (funct3) {
                    case 0: { // ADDW / SUBW
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._loadReg(out, rs2);
                        out.push(Buffer.from([funct7 === 0x20 ? 0x7d : 0x7c]));
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    case 1: { // SLLW
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        this._loadReg(out, rs2);
                        this._const64(out, 0x1fn);
                        out.push(Buffer.from([0x83])); // i64.and
                        out.push(Buffer.from([0x86])); // i64.shl
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    case 5: { // SRLW / SRAW
                        const isArithmetic = funct7 === 0x20;
                        this._beginStore(out, rd);
                        this._loadReg(out, rs1);
                        if (isArithmetic) this._emitSignExtend32(out);
                        else this._emitZeroExtend32(out);
                        this._loadReg(out, rs2);
                        this._const64(out, 0x1fn);
                        out.push(Buffer.from([0x83])); // i64.and
                        out.push(Buffer.from([isArithmetic ? 0x87 : 0x88]));
                        this._emitSignExtend32(out);
                        this._endStore(out, rd);
                        break;
                    }
                    default:
                        throw new Error(`unsupported OP-32 funct3=${funct3}`);
                }
                break;
            }
            case 0x33: { // OP
                switch (funct3) {
                    case 0: this._emitBinary(out, funct7 === 0x20 ? 0x7d : 0x7c, rd, rs1, rs2); break; // add/sub
                    case 1: this._emitBinary(out, 0x86, rd, rs1, rs2); break; // sll
                    case 2: this._emitBinary(out, 0x53, rd, rs1, rs2, true); break; // slt
                    case 3: this._emitBinary(out, 0x54, rd, rs1, rs2, true); break; // sltu
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
                this._endStore(out, rd);
                break;
            }
            case 0x17: { // AUIPC
                const immUpper = sext(insn & 0xfffff000, 32);
                this._beginStore(out, rd);
                this._emitPcConst(out, pc + immUpper);
                this._endStore(out, rd);
                break;
            }
            case 0x6f: { // JAL
                const imm = sext(
                    (((insn >>> 31) & 1) << 20) |
                    (((insn >>> 12) & 0xff) << 12) |
                    (((insn >>> 20) & 1) << 11) |
                    (((insn >>> 21) & 0x3ff) << 1),
                    21,
                );
                this._beginStore(out, rd);
                this._emitPcConst(out, pc + size);
                this._endStore(out, rd);
                this._emitReturnRel(out, pc + imm);
                break;
            }
            case 0x67: { // JALR
                this._beginStore(out, rd);
                this._emitPcConst(out, pc + size);
                this._endStore(out, rd);
                this._loadReg(out, rs1);
                this._const64(out, immI);
                out.push(Buffer.from([0x7c])); // i64.add
                this._const64(out, -2n);
                out.push(Buffer.from([0x83])); // i64.and (mask ~1)
                out.push(Buffer.from([0x0f])); // return
                break;
            }
            case 0x03: { // LOAD
                const loads = {
                    0: 0x30, // lb  (i64.load8_s)
                    1: 0x32, // lh  (i64.load16_s)
                    2: 0x34, // lw  (i64.load32_s)
                    3: 0x29, // ld  (i64.load)
                    4: 0x31, // lbu (i64.load8_u)
                    5: 0x33, // lhu (i64.load16_u)
                    6: 0x35, // lwu (i64.load32_u)
                };
                const loadOpcode = loads[funct3];
                if (loadOpcode === undefined) throw new Error(`unsupported LOAD funct3=${funct3}`);
                const loadSize = [1, 2, 4, 8, 1, 2, 4][funct3];
                this._emitLoad(out, rd, rs1, immI, loadOpcode, loadSize, pc);
                break;
            }
            case 0x23: { // STORE
                const stores = {
                    0: 0x3c, // sb (i64.store8)
                    1: 0x3d, // sh (i64.store16)
                    2: 0x3e, // sw (i64.store32)
                    3: 0x37, // sd (i64.store)
                };
                const storeOpcode = stores[funct3];
                if (storeOpcode === undefined) throw new Error(`unsupported STORE funct3=${funct3}`);
                const storeSize = [1, 2, 4, 8][funct3];
                this._emitStore(out, rs1, rs2, immS, storeOpcode, storeSize, pc);
                break;
            }
            case 0x63: { // BRANCH
                const imm = sext(
                    (((insn >>> 31) & 1) << 12) |
                    (((insn >>> 7) & 1) << 11) |
                    (((insn >>> 25) & 0x3f) << 5) |
                    (((insn >>> 8) & 0xf) << 1),
                    13,
                );
                const target = pc + imm;
                switch (funct3) {
                    case 0: this._emitConditionalBranch(out, 0x51, rs1, rs2, target); break; // beq
                    case 1: this._emitConditionalBranch(out, 0x52, rs1, rs2, target); break; // bne
                    case 4: this._emitConditionalBranch(out, 0x53, rs1, rs2, target); break; // blt
                    case 5: this._emitConditionalBranch(out, 0x59, rs1, rs2, target); break; // bge
                    case 6: this._emitConditionalBranch(out, 0x54, rs1, rs2, target); break; // bltu
                    case 7: this._emitConditionalBranch(out, 0x5a, rs1, rs2, target); break; // bgeu
                    default:
                        throw new Error(`unsupported BRANCH funct3=${funct3}`);
                }
                break;
            }
            default:
                throw new Error(`unsupported opcode 0x${opcode.toString(16)}`);
        }
    }
}

// Strictly validate the integer instructions the direct-TLB translator
// actually implements. In particular the M extension shares opcodes with the
// base ISA (funct7 0x01) and must be rejected, not silently treated as add.
function isSupportedInstruction(insn) {
    const opcode = insn & 0x7f;
    const funct3 = (insn >>> 12) & 7;
    const funct7 = (insn >>> 25) & 0x7f;
    switch (opcode) {
        case 0x13: // OP-IMM: funct7 is part of the immediate except for shifts
            if (funct3 === 1) return funct7 === 0x00; // slli
            if (funct3 === 5) return funct7 === 0x00 || funct7 === 0x20; // srli/srai
            return funct3 === 0 || funct3 === 2 || funct3 === 3 || funct3 === 4 ||
                funct3 === 6 || funct3 === 7;
        case 0x1b: // OP-IMM-32
            if (funct3 === 1) return funct7 === 0x00; // slliw
            if (funct3 === 5) return funct7 === 0x00 || funct7 === 0x20; // srliw/sraiw
            return funct3 === 0; // addiw (funct7 is immediate)
        case 0x33: // OP
            if (funct3 === 0) return funct7 === 0x00 || funct7 === 0x20; // add/sub
            if (funct3 === 5) return funct7 === 0x00 || funct7 === 0x20; // srl/sra
            return funct7 === 0x00; // sll/slt/sltu/xor/or/and
        case 0x3b: // OP-32
            if (funct3 === 0) return funct7 === 0x00 || funct7 === 0x20; // addw/subw
            if (funct3 === 1) return funct7 === 0x00; // sllw
            if (funct3 === 5) return funct7 === 0x00 || funct7 === 0x20; // srlw/sraw
            return false;
        case 0x03: // LOAD
            return funct3 <= 6;
        case 0x23: // STORE
            return funct3 <= 3;
        case 0x37: // LUI
        case 0x17: // AUIPC
        case 0x6f: // JAL
        case 0x67: // JALR
            return true;
        case 0x63: // BRANCH
            return funct3 !== 2 && funct3 !== 3; // no reserved encodings
        default:
            return false;
    }
}

function decodeBlock(code, pc) {
    const instructions = [];
    const sizes = [];
    let cursor = pc;
    while (cursor < code.length) {
        const decoded = decodeRiscV(code, cursor);
        if (!decoded) {
            return { instructions, sizes, terminal: 'unsupported', nextPc: cursor };
        }
        const insn = decoded.word >>> 0;
        const opcode = insn & 0x7f;
        if (!isSupportedInstruction(insn)) {
            return { instructions, sizes, terminal: 'unsupported', nextPc: cursor };
        }
        instructions.push(insn);
        sizes.push(decoded.size);
        if (opcode === 0x63 || opcode === 0x6f || opcode === 0x67) {
            return { instructions, sizes, terminal: opcode === 0x63 ? 'branch' : opcode === 0x6f ? 'jal' : 'jalr', nextPc: cursor + decoded.size };
        }
        cursor += decoded.size;
    }
    return { instructions, sizes, terminal: 'fallthrough', nextPc: cursor };
}

module.exports = { RiscVBlockJit, decodeBlock, isSupportedInstruction, u32leb, s32leb, s64leb, sext, BAIL_BIT, BAIL_MASK };

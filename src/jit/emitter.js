'use strict';

const {
    u32leb, s32leb, s64leb, str, section, vec, funcType, VAL, Code, OP,
} = require('./wasm');
const { PAGE_SIZE, PAGE_MASK, sext, immI, immS, branchOffset, jalOffset } = require('./decode');

// Region ABI:
//   (func $region (param $s i32) (param $pc i64) (param $ppage i32)
//                 (param $expected_gen i32) (result i32))
// Status: 0 CONTINUE, 1 EXCEPTION, 2 BUDGET, 3 INTERP.
const STATUS = { CONTINUE: 0, EXCEPTION: 1, BUDGET: 2, INTERP: 3 };

// Must match riscv_cpu.c.
const PAGE_GEN_BITS = 20;
const PAGE_GEN_MASK = (1 << PAGE_GEN_BITS) - 1;

// Imported globals (index order in the global index space).
const G_REG_BASE = 0;
const G_TLB_READ = 1;
const G_TLB_WRITE = 2;
const G_CYCLES = 3;
const G_PAGE_GEN = 4;
const G_PC = 5;
const G_LOAD_VAL = 6;
const G_TLB_TAG = 7;  // imported only with options.tlbTag

// Jump cache layout, mirrored from riscv_cpu.c (JITJumpEntry, jit_jc_index).
const JC_ENTRY_SIZE = 24;
const JC_OFF_TABLE_IDX = 8;
const JC_OFF_PPAGE = 12;
const JC_OFF_GEN = 16;
const JC_OFF_JC_GEN = 20;
const JC_OFF_PRIV = 22;
const JC_OFF_FS = 23;
const JC_BUCKETS = 1024;
const JC_BUCKET_ENTRIES = 64;

// Imported functions.
const F_SET_PC = 0;
const F_SUB_CYCLES = 1;
const F_STEP = 2;
const F_STORE = 3;
const F_LOAD = 4;
const F_CHAIN = 5;    // chain runtime (see buildChainRuntime)
const DEFINED_FUNC = 6;

// Locals.
const L_STATE = 0;
const L_PC = 1;
const L_PPAGE = 2;
const L_GEN = 3;
const L_REG_BASE = 4; // x1 .. x31  -> 4 .. 34
const L_N = 35;
const L_ENTRY = 36;
const L_BLOCK = 37;
const L_TMP = 38;
const L_STATUS = 39;  // exit status for the shared exit tail
const L_VADDR = 40;   // i64 guest virtual address
const L_TMP64 = 41;   // also: exit PC for the shared exit tail
const L_TMP64B = 42;
const L_TAG = 43;     // i64 TLB context tag (tagged-TLB emulators)
const L_EXTRA = 44;   // i32 locals for same-page access groups (2 per group)

function regLocal(reg) {
    return L_REG_BASE + reg - 1;
}

// Labels record the structural nesting level (tracked by Code) at the point
// where their block/loop/if was opened. `br` depth is then simply the
// difference to the current level, which stays correct inside any number of
// nested `if`s emitted by the instruction helpers.
class Labels {
    constructor(code) {
        this.code = code;
    }
    // Call right after emitting the block/loop/if opcode.
    open(name) {
        return { name, level: this.code.depth };
    }
    depth(label) {
        const d = this.code.depth - label.level;
        if (d < 0) throw new Error(`label ${label.name} is not active`);
        return d;
    }
}

class RegionEmitter {
    constructor(region, options = {}) {
        this.region = region;
        this.blockByOff = new Map(region.blocks.map((b) => [b.startOff, b]));
        this.c = new Code();
        this.labels = new Labels(this.c);
        this.loopLabel = null;
        this.exitLabel = null;
        // Instructions retired since the last update of $n that the emitter
        // has not materialised yet. Exits charge `$n + pendingN`, so only
        // block transitions need an actual add.
        this.pendingN = 0;
        // Direct write-TLB stores. Lockstep verification turns them off so
        // that every store goes through the (logged) helper.
        this.inlineStores = options.inlineStores !== false;
        // Slow-path load helper (jit_load_helper). Without it a read-TLB miss
        // ends the region.
        this.loadHelper = options.loadHelper !== false;
        // Region chaining: CONTINUE exits probe the jump cache and tail-call
        // the next region instead of returning to the interpreter loop.
        this.chain = !!options.chain;
        // Tagged TLB: entries hold page ^ tag; the tag is constant within a
        // region (only CSR writes and traps change it, and both end it).
        this.tlbTag = !!options.tlbTag;
        // Entries per TLB (TinyEMU TLB_SIZE; 256 on older images).
        this.tlbSize = options.tlbSize || 256;
        // Same-page coalescing of memory accesses (plan Phase 4).
        this.coalesce = options.coalesce !== false;
        this.extraI32 = 0;
        this.curGroup = null;
        const { used, written } = regionRegisters(region);
        this.usedRegs = used;
        this.writtenRegs = written;
    }

    emit() {
        const c = this.c;

        // Generation check at region entry.
        c.localGet(L_PPAGE);
        c.i32(PAGE_GEN_MASK);
        c.op(OP.i32and);
        c.i32(2);
        c.op(OP.i32shl);
        c.globalGet(G_PAGE_GEN);
        c.op(OP.i32add);
        c.mem(OP.i32load, 2, 0);
        c.localGet(L_GEN);
        c.op(OP.i32ne);
        c.op(OP.if, 0x40);
        c.i32(STATUS.INTERP);
        c.op(OP.return);
        c.op(OP.end);

        if (this.tlbTag) {
            c.globalGet(G_TLB_TAG);
            c.mem(OP.i64load, 3, 0);
            c.localSet(L_TAG);
        }

        // Load the registers the region reads or writes. Registers it never
        // touches stay in memory, and only written ones are flushed at exits.
        for (const r of this.usedRegs) this.loadRegFromMem(r);

        // n = 0; block = 0
        c.i32(0);
        c.localSet(L_N);
        c.i32(0);
        c.localSet(L_BLOCK);

        // Every exit branches to one shared tail with $n = retired count,
        // $tmp64 = next PC and $status set; the tail flushes the written
        // registers once. Inlining that flush at each exit made regions
        // ~200 bytes per guest instruction, and V8 compiles them lazily on
        // the emulator thread.
        c.op(OP.block, 0x40);
        this.tailLabel = this.labels.open('tail');
        c.op(OP.block, 0x40);
        const exitLabel = this.labels.open('exit');
        c.op(OP.loop, 0x40);
        this.loopLabel = this.labels.open('dispatch');

        // Open the case blocks in reverse so that case 0 is the innermost
        // block (br_table index 0 therefore maps to block 0 directly).
        const caseLabels = new Array(this.region.blocks.length);
        for (let i = this.region.blocks.length - 1; i >= 0; i--) {
            c.op(OP.block, 0x40);
            caseLabels[i] = this.labels.open(`case${i}`);
        }

        // Dispatch on the block id.
        c.localGet(L_BLOCK);
        c.brTable(
            caseLabels.map((l) => this.labels.depth(l)),
            this.labels.depth(exitLabel),
        );

        for (let i = 0; i < this.region.blocks.length; i++) {
            c.op(OP.end); // case i
            this.emitBlockBody(this.region.blocks[i]);
            // Every body ends in a return or a branch to dispatch/tail. Add a
            // defensive branch in case a future end kind falls through.
            this.c.br(this.labels.depth(this.loopLabel));
        }

        c.op(OP.end); // dispatch loop
        c.op(OP.end); // exit block
        // Defensive fallback for an out-of-range br_table index.
        c.i32(STATUS.INTERP);
        c.op(OP.return);
        c.op(OP.end); // tail block

        // Shared exit tail.
        this.flushRegs();
        c.globalGet(G_CYCLES);
        c.globalGet(G_CYCLES);
        c.mem(OP.i32load, 2, 0);
        c.localGet(L_N);
        c.op(OP.i32sub);
        c.mem(OP.i32store, 2, 0);
        c.globalGet(G_PC);
        c.localGet(L_TMP64);
        c.mem(OP.i64store, 3, 0);
        if (this.chain) this.emitChain();
        c.localGet(L_STATUS);
        c.op(OP.end); // function

        return c.finish();
    }

    // CONTINUE exits tail-call the chain runtime, which continues directly in
    // the next region when the interpreter loop would do nothing else first.
    // Everything (registers, s->pc, n_cycles) is already in memory.
    emitChain() {
        const c = this.c;
        c.localGet(L_STATUS);
        c.op(OP.if, 0x40);
        c.localGet(L_STATUS);
        c.op(OP.return);
        c.op(OP.end);
        c.localGet(L_STATE);
        c.localGet(L_TMP64);
        c.i32(0);
        c.i32(0);
        c.u8(0x12); // return_call
        c.uleb(F_CHAIN);
    }

    brToDispatch() {
        this.c.br(this.labels.depth(this.loopLabel));
    }

    emitBlockBody(block) {
        // Budget check at the block boundary. n counts the instructions
        // already retired, so a region can run across several loop iterations
        // and still be interrupted between blocks.
        const c = this.c;
        this.pendingN = 0;
        c.globalGet(G_CYCLES);
        c.mem(OP.i32load, 2, 0);
        c.localGet(L_N);
        c.op(OP.i32sub);
        c.i32(0);
        c.op(OP.i32le_s);
        c.op(OP.if, 0x40);
        this.emitExit(block.startOff, STATUS.BUDGET);
        c.op(OP.end);

        const insns = block.insns;
        const groups = this.coalesce ? this.findGroups(insns) : new Map();
        for (let i = 0; i < insns.length; i++) {
            const insn = insns[i];
            const isTerminator = i === insns.length - 1 && block.end.kind !== 'exit';
            if (isTerminator) {
                this.emitTerminator(block);
                return;
            }
            this.curGroup = groups.get(i) || null;
            const counted = this.emitInstruction(insn);
            this.curGroup = null;
            if (!counted) this.incN();
        }

        // A block with no emitted terminator (e.g. an empty block whose end is
        // an interpreter exit) exits precisely at its end PC.
        if (block.end.kind === 'exit') {
            this.emitExit(block.end.exitOff,
                block.end.status === 'continue' ? STATUS.CONTINUE : STATUS.INTERP);
        } else {
            this.emitExit(block.startOff, STATUS.INTERP);
        }
    }

    emitTerminator(block) {
        const end = block.end;
        const last = block.insns[block.insns.length - 1];
        switch (end.kind) {
            case 'branch': {
                this.incN();
                this.materializeN();
                this.emitCond(end.funct3, end.rs1, end.rs2);
                this.c.op(OP.if, 0x40);
                this.pushEdge(end.targetOff);
                this.c.op(OP.else);
                this.pushEdge(end.fallthroughOff);
                this.c.op(OP.end);
                return;
            }
            case 'jal': {
                this.incN();
                this.materializeN();
                this.pushEdge(end.targetOff);
                return;
            }
            case 'jal-call': {
                this.incN();
                if (end.rd !== 0) {
                    this.emitPcRel(end.linkOff);
                    this.c.localSet(regLocal(end.rd));
                }
                this.emitExit(end.targetOff, STATUS.CONTINUE);
                return;
            }
            case 'jalr': {
                this.incN();
                // Compute the target from the old rs1 before writing rd, so
                // `jalr rs1, rs1, 0` still works.
                this.loadReg(end.rs1);
                if (end.imm !== 0) {
                    this.c.i64(BigInt(end.imm));
                    this.c.op(OP.i64add);
                }
                this.c.i64(-2n);
                this.c.op(OP.i64and);
                this.c.localSet(L_TMP64);
                if (end.rd !== 0) {
                    this.emitPcRel(end.linkOff);
                    this.c.localSet(regLocal(end.rd));
                }
                this.exitToTail(STATUS.CONTINUE, 0);
                return;
            }
            default:
                this.emitExit(block.end.exitOff, STATUS.INTERP);
        }
        void last;
    }

    pushEdge(off) {
        if (off >= 0 && off < PAGE_SIZE) {
            const target = this.blockByOff.get(off);
            if (target) {
                this.c.i32(target.id);
                this.c.localSet(L_BLOCK);
                this.brToDispatch();
                return;
            }
        }
        this.emitExit(off, STATUS.CONTINUE);
    }

    // `extra` retired instructions are charged on top of $n + pendingN.
    emitExit(off, status, extra = 0) {
        this.emitPcRel(off);
        this.c.localSet(L_TMP64);
        this.exitToTail(status, extra);
    }

    // $n += pendingN + extra; $status = status; br tail ($tmp64 = next PC).
    exitToTail(status, extra) {
        const c = this.c;
        const k = this.pendingN + extra;
        if (k !== 0) {
            c.localGet(L_N);
            c.i32(k);
            c.op(OP.i32add);
            c.localSet(L_N);
        }
        c.i32(status);
        c.localSet(L_STATUS);
        c.br(this.labels.depth(this.tailLabel));
    }

    // s->pc = pc_param + (off - entryOff)
    setPc(off) {
        this.c.globalGet(G_PC);
        this.emitPcRel(off);
        this.c.mem(OP.i64store, 3, 0);
    }

    // Push pc_param + (off - entryOff).
    emitPcRel(off) {
        this.c.localGet(L_PC);
        const delta = off - this.region.entryOff;
        if (delta !== 0) {
            this.c.i64(BigInt(delta));
            this.c.op(OP.i64add);
        }
    }

    emitPcRelAbsolute(off) {
        this.c.localGet(L_STATE);
        this.emitPcRel(off);
    }

    flushRegs() {
        for (const r of this.writtenRegs) {
            this.c.globalGet(G_REG_BASE);
            this.c.localGet(regLocal(r));
            this.c.mem(OP.i64store, 3, r * 8);
        }
    }

    loadRegFromMem(r) {
        this.c.globalGet(G_REG_BASE);
        this.c.mem(OP.i64load, 3, r * 8);
        this.c.localSet(regLocal(r));
    }

    // n_cycles -= $n + pendingN + extra
    subCycles(extra = 0) {
        const c = this.c;
        c.globalGet(G_CYCLES);
        c.globalGet(G_CYCLES);
        c.mem(OP.i32load, 2, 0);
        c.localGet(L_N);
        const k = this.pendingN + extra;
        if (k !== 0) {
            c.i32(k);
            c.op(OP.i32add);
        }
        c.op(OP.i32sub);
        c.mem(OP.i32store, 2, 0);
    }

    // Count one retired instruction (statically; see materializeN).
    incN() {
        this.pendingN++;
    }

    materializeN() {
        if (this.pendingN === 0) return;
        this.c.localGet(L_N);
        this.c.i32(this.pendingN);
        this.c.op(OP.i32add);
        this.c.localSet(L_N);
        this.pendingN = 0;
    }

    loadReg(reg) {
        if (reg === 0) this.c.i64(0n);
        else this.c.localGet(regLocal(reg));
        return this;
    }

    storeReg(reg) {
        if (reg === 0) this.c.op(0x1a); // drop
        else this.c.localSet(regLocal(reg));
        return this;
    }

    emitCond(funct3, rs1, rs2) {
        const ops = {
            0: OP.i64eq, 1: OP.i64ne, 4: OP.i64lt_s, 5: OP.i64ge_s,
            6: OP.i64lt_u, 7: OP.i64ge_u,
        };
        this.loadReg(rs1);
        this.loadReg(rs2);
        this.c.op(ops[funct3]);
    }

    emitInstruction(insn) {
        const word = insn.word;
        const opcode = word & 0x7f;
        if (opcode === 0x2f || opcode === 0x07 || opcode === 0x27 ||
            opcode === 0x43 || opcode === 0x47 || opcode === 0x4b ||
            opcode === 0x4f || opcode === 0x53 || opcode === 0x73) {
            return this.emitHelper(insn);
        }
        const rd = (word >>> 7) & 0x1f;
        const rs1 = (word >>> 15) & 0x1f;
        const rs2 = (word >>> 20) & 0x1f;
        const funct3 = (word >>> 12) & 7;
        const funct7 = (word >>> 25) & 0x7f;

        switch (opcode) {
            case 0x13: return this.emitOpImm(word, rd, rs1, funct3, funct7, immI(word));
            case 0x1b: return this.emitOpImm32(word, rd, rs1, funct3, immI(word));
            case 0x33: return this.emitOp(word, rd, rs1, rs2, funct3, funct7);
            case 0x3b: return this.emitOp32(word, rd, rs1, rs2, funct3, funct7);
            case 0x37: // LUI
                this.c.i64(BigInt(sext(word & 0xfffff000, 32)));
                this.storeReg(rd);
                return false;
            case 0x17: // AUIPC
                this.emitPcRel(insn.off);
                this.c.i64(BigInt(sext(word & 0xfffff000, 32)));
                this.c.op(OP.i64add);
                this.storeReg(rd);
                return false;
            case 0x03: return this.emitLoad(insn, rd, rs1, funct3);
            case 0x23: return this.emitStore(insn, rs1, rs2, funct3);
            case 0x0f: // fence/fence.tso: no-op on a single hart
                return false;
            default:
                // The region builder never includes other opcodes.
                this.emitExit(insn.off, STATUS.INTERP);
                return true;
        }
    }

    // Execute one rare instruction through the single-step interpreter. The
    // region flushes the integer register file first, so jit_step sees exact
    // state, and reloads it afterwards because the helper may write rd.
    emitHelper(insn) {
        const c = this.c;
        this.flushRegs();
        this.setPc(insn.off);

        c.localGet(L_STATE);
        c.call(F_STEP);
        // Non-zero: jit_step took a trap and already set s->pc to the handler.
        // The interpreter charges the instruction plus one exception cycle.
        c.op(OP.if, 0x40);
        this.subCycles(2);
        c.i32(STATUS.CONTINUE);
        c.op(OP.return);
        c.op(OP.end);
        this.incN();

        // The helper only writes its destination register (integer rd for
        // AMOs and FP->int ops; for FP destinations this reloads an
        // unchanged integer register, which is harmless).
        const rd = (insn.word >>> 7) & 0x1f;
        if (rd !== 0 && this.usedRegs.includes(rd)) this.loadRegFromMem(rd);

        // A helper store may have modified this page (self-modifying code) or
        // changed an MMU mapping. Leave the region if the generation moved.
        c.localGet(L_PPAGE);
        c.i32(PAGE_GEN_MASK);
        c.op(OP.i32and);
        c.i32(2);
        c.op(OP.i32shl);
        c.globalGet(G_PAGE_GEN);
        c.op(OP.i32add);
        c.mem(OP.i32load, 2, 0);
        c.localGet(L_GEN);
        c.op(OP.i32ne);
        c.op(OP.if, 0x40);
        this.emitExit(insn.off + insn.size, STATUS.INTERP);
        c.op(OP.end);
        return true;
    }

    emitOpImm(word, rd, rs1, funct3, funct7, imm) {
        const c = this.c;
        switch (funct3) {
            case 0: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64add); break;
            case 2: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64lt_s); c.op(OP.i64extend_i32_u); break;
            case 3: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64lt_u); c.op(OP.i64extend_i32_u); break;
            case 4: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64xor); break;
            case 6: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64or); break;
            case 7: this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64and); break;
            case 1:
                this.loadReg(rs1); c.i64(BigInt(imm & 0x3f)); c.op(OP.i64shl); break;
            case 5:
                this.loadReg(rs1); c.i64(BigInt(imm & 0x3f));
                c.op((funct7 & 0x20) ? OP.i64shr_s : OP.i64shr_u);
                break;
            default:
                throw new Error(`unhandled OP-IMM funct3=${funct3}`);
        }
        this.storeReg(rd);
        return false;
    }

    emitOpImm32(word, rd, rs1, funct3, imm) {
        const c = this.c;
        switch (funct3) {
            case 0: // ADDIW
                this.loadReg(rs1); c.i64(BigInt(imm)); c.op(OP.i64add);
                this.signExtend32(); break;
            case 1: // SLLIW
                this.loadReg(rs1); c.i64(BigInt(imm & 0x1f)); c.op(OP.i64shl);
                this.signExtend32(); break;
            case 5: { // SRLIW/SRAIW
                const arithmetic = (word >>> 30) & 1;
                this.loadReg(rs1);
                if (arithmetic) this.signExtend32();
                else this.zeroExtend32();
                c.i64(BigInt(imm & 0x1f));
                c.op(arithmetic ? OP.i64shr_s : OP.i64shr_u);
                this.signExtend32();
                break;
            }
            default:
                throw new Error(`unhandled OP-IMM-32 funct3=${funct3}`);
        }
        this.storeReg(rd);
        return false;
    }

    emitOp(word, rd, rs1, rs2, funct3, funct7) {
        const c = this.c;
        if (funct7 === 0x01) {
            return this.emitMulDiv(rd, rs1, rs2, funct3, 64);
        }
        switch (funct3) {
            case 0: this.loadReg(rs1); this.loadReg(rs2); c.op(funct7 === 0x20 ? OP.i64sub : OP.i64add); break;
            case 1: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64shl); break;
            case 2: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64lt_s); c.op(OP.i64extend_i32_u); break;
            case 3: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64lt_u); c.op(OP.i64extend_i32_u); break;
            case 4: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64xor); break;
            case 5: this.loadReg(rs1); this.loadReg(rs2); c.op(funct7 === 0x20 ? OP.i64shr_s : OP.i64shr_u); break;
            case 6: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64or); break;
            case 7: this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64and); break;
            default: throw new Error(`unhandled OP funct3=${funct3}`);
        }
        this.storeReg(rd);
        return false;
    }

    emitOp32(word, rd, rs1, rs2, funct3, funct7) {
        const c = this.c;
        if (funct7 === 0x01) {
            return this.emitMulDiv(rd, rs1, rs2, funct3, 32);
        }
        switch (funct3) {
            case 0: // ADDW/SUBW
                this.loadReg(rs1); c.op(OP.i32wrap_i64);
                this.loadReg(rs2); c.op(OP.i32wrap_i64);
                c.op(funct7 === 0x20 ? OP.i32sub : OP.i32add);
                c.op(OP.i64extend_i32_s);
                break;
            case 1: // SLLW
                this.loadReg(rs1); c.op(OP.i32wrap_i64);
                this.loadReg(rs2); c.op(OP.i32wrap_i64); c.i32(0x1f); c.op(OP.i32and);
                c.op(OP.i32shl);
                c.op(OP.i64extend_i32_s);
                break;
            case 5: { // SRLW/SRAW
                const arithmetic = funct7 === 0x20;
                this.loadReg(rs1); c.op(OP.i32wrap_i64);
                this.loadReg(rs2); c.op(OP.i32wrap_i64); c.i32(0x1f); c.op(OP.i32and);
                c.op(arithmetic ? OP.i32shr_s : OP.i32shr_u);
                c.op(OP.i64extend_i32_s);
                break;
            }
            default: throw new Error(`unhandled OP-32 funct3=${funct3}`);
        }
        this.storeReg(rd);
        return false;
    }

    // funct3 for RV64M: 0 mul/mulw, 4 div, 5 divu, 6 rem, 7 remu.
    emitMulDiv(rd, rs1, rs2, funct3, width) {
        const c = this.c;
        if (funct3 === 0) {
            if (width === 64) {
                this.loadReg(rs1); this.loadReg(rs2); c.op(OP.i64mul);
            } else {
                this.loadReg(rs1); c.op(OP.i32wrap_i64);
                this.loadReg(rs2); c.op(OP.i32wrap_i64);
                c.op(OP.i32mul);
                c.op(OP.i64extend_i32_s);
            }
            this.storeReg(rd);
            return false;
        }

        const signed = funct3 === 4 || funct3 === 6;
        const isRem = funct3 === 6 || funct3 === 7;
        this.pushWideOperand(rs1, width, signed);
        c.localSet(L_TMP64);
        this.pushWideOperand(rs2, width, signed);
        c.localSet(L_TMP64B);

        c.localGet(L_TMP64B);
        c.op(OP.i64eqz);
        c.op(OP.if, VAL.i64);
        if (isRem) c.localGet(L_TMP64);
        else c.i64(-1n);
        c.op(OP.else);
        if (signed) {
            c.localGet(L_TMP64); c.i64(-(1n << 63n)); c.op(OP.i64eq);
            c.localGet(L_TMP64B); c.i64(-1n); c.op(OP.i64eq);
            c.op(OP.i32and);
            c.op(OP.if, VAL.i64);
            if (isRem) c.i64(0n);
            else c.localGet(L_TMP64);
            c.op(OP.else);
            c.localGet(L_TMP64);
            c.localGet(L_TMP64B);
            c.op(isRem ? OP.i64rem_s : OP.i64div_s);
            c.op(OP.end);
        } else {
            c.localGet(L_TMP64);
            c.localGet(L_TMP64B);
            c.op(isRem ? OP.i64rem_u : OP.i64div_u);
        }
        c.op(OP.end);
        if (width === 32) this.signExtend32();
        this.storeReg(rd);
        return false;
    }

    pushWideOperand(reg, width, signed) {
        this.loadReg(reg);
        if (width === 32) {
            this.c.op(OP.i32wrap_i64);
            this.c.op(signed ? OP.i64extend_i32_s : OP.i64extend_i32_u);
        }
    }

    // Same-page access groups. A group is a run of loads (or of stores) in
    // one block through the same base register, which no instruction in
    // between writes. One check at the first member (offset range within
    // one page, base aligned for every member, TLB entry for that page
    // present) lets every member access host memory directly; otherwise each
    // member takes its normal per-access path. Returns index -> member info.
    findGroups(insns) {
        const result = new Map();
        const memKind = (w) => {
            const op = w & 0x7f;
            if (op === 0x03 && ((w >>> 12) & 7) <= 6) return 'r';
            if (op === 0x23 && ((w >>> 12) & 7) <= 3 && this.inlineStores) return 'w';
            return null;
        };
        const writesReg = (w) => {
            switch (w & 0x7f) {
                case 0x23: case 0x63: case 0x0f: return 0;
                default: return (w >>> 7) & 0x1f;
            }
        };
        const isHelper = (w) => {
            const op = w & 0x7f;
            return op === 0x2f || op === 0x07 || op === 0x27 || op === 0x43 || op === 0x47 ||
                op === 0x4b || op === 0x4f || op === 0x53 || op === 0x73;
        };
        const last = insns.length - 1;
        let slot = 0;
        for (let i = 0; i < last; i++) {
            if (result.has(i)) continue;
            const w = insns[i].word;
            const kind = memKind(w);
            if (!kind) continue;
            const base = (w >>> 15) & 0x1f;
            if (base === 0) continue;
            const members = [i];
            if (kind === 'r' && writesReg(w) === base) continue;
            for (let j = i + 1; j < last; j++) {
                const wj = insns[j].word;
                if (isHelper(wj)) break;
                if (memKind(wj) === kind && ((wj >>> 15) & 0x1f) === base && !result.has(j)) {
                    members.push(j);
                    if (writesReg(wj) === base) break;
                    continue;
                }
                if (writesReg(wj) === base) break;
            }
            if (members.length < 2) continue;
            const acc = members.map((k) => {
                const ww = insns[k].word;
                const f3 = (ww >>> 12) & 7;
                const size = kind === 'r' ? [1, 2, 4, 8, 1, 2, 4][f3] : 1 << f3;
                const off = kind === 'r' ? immI(ww) : immS(ww);
                return { k, size, off };
            });
            // Members must be aligned relative to an aligned base.
            if (acc.some((a) => a.off % a.size !== 0)) continue;
            const lo = Math.min(...acc.map((a) => a.off));
            const hi = Math.max(...acc.map((a) => a.off + a.size - 1));
            if (hi - lo >= PAGE_SIZE) continue;
            const group = {
                kind, base, lo, hi,
                align: Math.max(...acc.map((a) => a.size)),
                ok: L_EXTRA + slot * 2,
                host: L_EXTRA + slot * 2 + 1,
            };
            slot++;
            for (const a of acc) result.set(a.k, { group, first: a.k === i, off: a.off });
        }
        this.extraI32 = Math.max(this.extraI32, slot * 2);
        return result;
    }

    // ok = same page for [base+lo, base+hi] && base aligned && TLB hit;
    // host = host address of `base` (valid when ok).
    emitGroupCheck(group) {
        const c = this.c;
        const tlb = group.kind === 'r' ? G_TLB_READ : G_TLB_WRITE;
        this.emitAddress(group.base, group.lo, tlb); // L_VADDR = base + lo
        c.localGet(L_ENTRY);
        c.mem(OP.i64load, 3, 0);
        c.localGet(L_VADDR);
        c.i64(-4096n);
        c.op(OP.i64and);
        this.xorTag();
        c.op(OP.i64eq);
        c.localGet(L_VADDR);
        c.i64(12n);
        c.op(OP.i64shr_u);
        this.loadReg(group.base);
        if (group.hi !== 0) {
            c.i64(BigInt(group.hi));
            c.op(OP.i64add);
        }
        c.i64(12n);
        c.op(OP.i64shr_u);
        c.op(OP.i64eq);
        c.op(OP.i32and);
        if (group.align > 1) {
            this.loadReg(group.base);
            c.op(OP.i32wrap_i64);
            c.i32(group.align - 1);
            c.op(OP.i32and);
            c.op(OP.i32eqz);
            c.op(OP.i32and);
        }
        c.localSet(group.ok);
        this.loadReg(group.base);
        c.op(OP.i32wrap_i64);
        c.localGet(L_ENTRY);
        c.mem(OP.i32load, 2, 8);
        c.op(OP.i32add);
        c.localSet(group.host);
    }

    // Push the i32 host address operand for a grouped access and return the
    // memarg offset to use.
    groupAddr(info) {
        const c = this.c;
        c.localGet(info.group.host);
        if (info.off >= 0) return info.off;
        c.i32(info.off);
        c.op(OP.i32add);
        return 0;
    }

    emitLoad(insn, rd, rs1, funct3) {
        const info = this.curGroup;
        if (!info) return this.emitLoadInner(insn, rd, rs1, funct3);
        const c = this.c;
        const loadOps = [OP.i64load8_s, OP.i64load16_s, OP.i64load32_s, OP.i64load,
            OP.i64load8_u, OP.i64load16_u, OP.i64load32_u];
        if (info.first) this.emitGroupCheck(info.group);
        c.localGet(info.group.ok);
        c.op(OP.if, VAL.i64);
        const off = this.groupAddr(info);
        c.mem(loadOps[funct3], 0, off);
        c.op(OP.else);
        this.emitLoadValue(insn, rs1, funct3);
        c.op(OP.end);
        this.storeReg(rd);
        this.incN();
        return true;
    }

    emitLoadInner(insn, rd, rs1, funct3) {
        this.emitLoadValue(insn, rs1, funct3);
        this.storeReg(rd);
        this.incN();
        return true;
    }

    // Push the loaded (extended) i64 value: inline read-TLB probe, then the
    // slow helper (or a precise exit).
    emitLoadValue(insn, rs1, funct3) {
        const c = this.c;
        const loadOps = [OP.i64load8_s, OP.i64load16_s, OP.i64load32_s, OP.i64load,
            OP.i64load8_u, OP.i64load16_u, OP.i64load32_u];
        const sizes = [1, 2, 4, 8, 1, 2, 4];
        const size = sizes[funct3];
        const tagMask = BigInt.asIntN(64, -4096n + BigInt(size - 1));
        this.emitAddress(rs1, immI(insn.word), G_TLB_READ);
        // if (tlb tag matches)
        c.localGet(L_ENTRY);
        c.mem(OP.i64load, 3, 0);
        c.localGet(L_VADDR);
        c.i64(tagMask);
        c.op(OP.i64and);
        this.xorTag();
        c.op(OP.i64eq);
        c.op(OP.if, VAL.i64);
        c.localGet(L_VADDR);
        c.op(OP.i32wrap_i64);
        c.localGet(L_ENTRY);
        c.mem(OP.i32load, 2, 8);
        c.op(OP.i32add);
        c.mem(loadOps[funct3], 0, 0);
        c.op(OP.else);
        if (this.loadHelper) {
            // Slow path: page walk (and MMIO) in C. The value comes back
            // through jit_load_value, read with the same extending load.
            c.localGet(L_STATE);
            c.localGet(L_VADDR);
            c.i32([0, 1, 2, 3, 0, 1, 2][funct3]);
            c.call(F_LOAD);
            c.op(OP.if, 0x40);
            // FAULT: count the load; mmu_exception charges the exception.
            this.emitExit(insn.off, STATUS.EXCEPTION, 1);
            c.op(OP.end);
            c.globalGet(G_LOAD_VAL);
            c.mem(loadOps[funct3], 0, 0);
        } else {
            this.emitExit(insn.off, STATUS.INTERP);
            c.op(OP.unreachable);
        }
        c.op(OP.end);
    }

    emitStore(insn, rs1, rs2, funct3) {
        const c = this.c;
        const sizeLog2 = [0, 1, 2, 3][funct3];
        if (sizeLog2 === undefined) throw new Error(`unhandled STORE funct3=${funct3}`);
        const imm = immS(insn.word);

        const info = this.curGroup;
        if (info) {
            // Grouped: the page was checked once for the whole group.
            const storeOps = [OP.i64store8, OP.i64store16, OP.i64store32, OP.i64store];
            if (info.first) this.emitGroupCheck(info.group);
            c.localGet(info.group.ok);
            c.op(OP.if, 0x40);
            const off = this.groupAddr(info);
            this.loadReg(rs2);
            c.mem(storeOps[sizeLog2], 0, off);
            c.op(OP.else);
            this.emitStoreInline(insn, rs1, rs2, sizeLog2, imm);
            c.op(OP.end);
        } else if (this.inlineStores) {
            this.emitStoreInline(insn, rs1, rs2, sizeLog2, imm);
        } else {
            this.emitStoreHelper(insn, rs2, sizeLog2, () => {
                this.loadReg(rs1);
                if (imm !== 0) {
                    c.i64(BigInt(imm));
                    c.op(OP.i64add);
                }
            });
        }
        this.incN();
        return true;
    }

    emitStoreInline(insn, rs1, rs2, sizeLog2, imm) {
        const c = this.c;
        {
            // Write-TLB fast path, identical to target_write_uN. Watched code
            // pages are never entered in the write TLB (target_write_slow
            // refuses them and jit_watch_page drops the TLB), so a direct
            // store can never modify translated code behind its generation.
            const size = 1 << sizeLog2;
            const tagMask = BigInt.asIntN(64, -4096n + BigInt(size - 1));
            const storeOps = [OP.i64store8, OP.i64store16, OP.i64store32, OP.i64store];
            this.emitAddress(rs1, imm, G_TLB_WRITE);
            c.localGet(L_ENTRY);
            c.mem(OP.i64load, 3, 0);
            c.localGet(L_VADDR);
            c.i64(tagMask);
            c.op(OP.i64and);
            this.xorTag();
            c.op(OP.i64eq);
            c.op(OP.if, 0x40);
            c.localGet(L_VADDR);
            c.op(OP.i32wrap_i64);
            c.localGet(L_ENTRY);
            c.mem(OP.i32load, 2, 8);
            c.op(OP.i32add);
            this.loadReg(rs2);
            c.mem(storeOps[sizeLog2], 0, 0);
            c.op(OP.else);
            this.emitStoreHelper(insn, rs2, sizeLog2, () => c.localGet(L_VADDR));
            c.op(OP.end);
        }
    }

    // Slow path: the C helper walks the page table, checks the watch bitmap
    // and reports FAULT / INVALID (watched page written) / SLOW (MMIO).
    emitStoreHelper(insn, rs2, sizeLog2, pushAddr) {
        const c = this.c;
        c.localGet(L_STATE);
        pushAddr();
        this.loadReg(rs2);
        c.i32(sizeLog2);
        c.call(F_STORE);
        c.localTee(L_TMP);
        c.op(OP.if, 0x40);
        c.localGet(L_TMP);
        c.i32(1);
        c.op(OP.i32eq);
        c.op(OP.if, 0x40);
        // FAULT: pending_exception is set. Count the store; the interpreter's
        // mmu_exception path charges the exception cycle.
        this.emitExit(insn.off, STATUS.EXCEPTION, 1);
        c.op(OP.else);
        // INVALID or SLOW: retire the store and let the interpreter observe
        // the new state (new code generation, pending interrupt) at the next PC.
        this.emitExit(insn.off + insn.size, STATUS.INTERP, 1);
        c.op(OP.end);
        c.op(OP.end);
    }

    // vaddr = reg[rs1] + imm; entry = tlb_base + ((vaddr >> 12) & (size-1)) * 16
    emitAddress(rs1, imm, globalBase) {
        const c = this.c;
        this.loadReg(rs1);
        if (imm !== 0) {
            c.i64(BigInt(imm));
            c.op(OP.i64add);
        }
        c.localSet(L_VADDR);
        c.localGet(L_VADDR);
        c.op(OP.i32wrap_i64);
        c.i32(12);
        c.op(OP.i32shr_u);
        c.i32(this.tlbSize - 1);
        c.op(OP.i32and);
        c.i32(4);
        c.op(OP.i32shl);
        c.globalGet(globalBase);
        c.op(OP.i32add);
        c.localSet(L_ENTRY);
    }

    xorTag() {
        if (!this.tlbTag) return;
        this.c.localGet(L_TAG);
        this.c.op(OP.i64xor);
    }

    signExtend32() {
        this.c.op(OP.i32wrap_i64);
        this.c.op(OP.i64extend_i32_s);
    }

    zeroExtend32() {
        this.c.op(OP.i32wrap_i64);
        this.c.op(OP.i64extend_i32_u);
    }
}

// Chain runtime: one small module per VM that imports the emulator's function
// table. Regions tail-call its `chain` export instead of importing the table
// themselves: V8 keeps a dispatch-table copy per importing instance and
// updates all of them on every table.set, which made installs O(n^2).
//
// chain(s, pc, _, _): return to the interpreter loop (CONTINUE) when it would
// act (budget exhausted, interrupt pending) or the jump cache misses;
// otherwise return_call_indirect the region, exactly like jit_try_region().
function buildChainRuntime() {
    const c = new Code();
    const P_STATE = 0;
    const P_PC = 1;
    const L_E = 4;
    const G = { CYCLES: 0, MIP: 1, MIE: 2, JC_BASE: 3, JC_GEN: 4, PRIV: 5, FS: 6, STAT: 7 };
    const cont = () => {
        c.op(OP.if, 0x40);
        c.i32(STATUS.CONTINUE);
        c.op(OP.return);
        c.op(OP.end);
    };
    c.globalGet(G.CYCLES);
    c.mem(OP.i32load, 2, 0);
    c.i32(0);
    c.op(OP.i32le_s);
    cont();
    c.globalGet(G.MIP);
    c.mem(OP.i32load, 2, 0);
    c.globalGet(G.MIE);
    c.mem(OP.i32load, 2, 0);
    c.op(OP.i32and);
    cont();
    // entry = jc_base + (bucket(vpn) * 64 + ((pc >> 1) & 63)) * 24
    c.localGet(P_PC);
    c.i64(12n);
    c.op(OP.i64shr_u);
    c.op(OP.i32wrap_i64);
    c.i32(2654435761 | 0);
    c.op(OP.i32mul);
    c.i32(JC_BUCKETS - 1);
    c.op(OP.i32and);
    c.i32(JC_BUCKET_ENTRIES);
    c.op(OP.i32mul);
    c.localGet(P_PC);
    c.op(OP.i32wrap_i64);
    c.i32(1);
    c.op(OP.i32shr_u);
    c.i32(JC_BUCKET_ENTRIES - 1);
    c.op(OP.i32and);
    c.op(OP.i32add);
    c.i32(JC_ENTRY_SIZE);
    c.op(OP.i32mul);
    c.globalGet(G.JC_BASE);
    c.op(OP.i32add);
    c.localSet(L_E);
    // miss = vpc != pc | jc_gen != (jit_jump_gen & 0xffff)
    //      | priv != s->priv | fsbit != (s->fs != 0)
    c.localGet(L_E);
    c.mem(OP.i64load, 3, 0);
    c.localGet(P_PC);
    c.op(OP.i64ne);
    c.localGet(L_E);
    c.mem(OP.i32load16_u, 1, JC_OFF_JC_GEN);
    c.globalGet(G.JC_GEN);
    c.mem(OP.i32load16_u, 1, 0);
    c.op(OP.i32ne);
    c.op(OP.i32or);
    c.localGet(L_E);
    c.mem(OP.i32load8_u, 0, JC_OFF_PRIV);
    c.globalGet(G.PRIV);
    c.mem(OP.i32load8_u, 0, 0);
    c.op(OP.i32ne);
    c.op(OP.i32or);
    c.localGet(L_E);
    c.mem(OP.i32load8_u, 0, JC_OFF_FS);
    c.globalGet(G.FS);
    c.mem(OP.i32load8_u, 0, 0);
    c.i32(0);
    c.op(OP.i32ne);
    c.op(OP.i32ne);
    c.op(OP.i32or);
    // table_idx == 0: negative entry ("no region for this PC")
    c.localGet(L_E);
    c.mem(OP.i32load, 2, JC_OFF_TABLE_IDX);
    c.op(OP.i32eqz);
    c.op(OP.i32or);
    cont();
    // jit_stats.chained++
    c.globalGet(G.STAT);
    c.globalGet(G.STAT);
    c.mem(OP.i64load, 3, 0);
    c.i64(1n);
    c.op(OP.i64add);
    c.mem(OP.i64store, 3, 0);
    c.localGet(P_STATE);
    c.localGet(P_PC);
    c.localGet(L_E);
    c.mem(OP.i32load, 2, JC_OFF_PPAGE);
    c.localGet(L_E);
    c.mem(OP.i32load, 2, JC_OFF_GEN);
    c.localGet(L_E);
    c.mem(OP.i32load, 2, JC_OFF_TABLE_IDX);
    c.u8(OP.return_call_indirect);
    c.uleb(0); // type: region
    c.uleb(0); // table: env.table
    c.op(OP.end);
    const body = Buffer.concat([vec([Buffer.concat([u32leb(1), Buffer.from([VAL.i32])])]), c.finish()]);

    const g = (name) => Buffer.concat([str('env'), str(name), Buffer.from([0x03, VAL.i32, 0x00])]);
    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        section(1, vec([funcType([VAL.i32, VAL.i64, VAL.i32, VAL.i32], [VAL.i32])])),
        section(2, vec([
            Buffer.concat([str('env'), str('memory'), Buffer.from([0x02, 0x00]), u32leb(1)]),
            Buffer.concat([str('env'), str('table'), Buffer.from([0x01, 0x70, 0x00, 0x00])]),
            g('cycles_ptr'), g('mip_ptr'), g('mie_ptr'), g('jc_base'), g('jc_gen_ptr'),
            g('priv_ptr'), g('fs_ptr'), g('chain_stat_ptr'),
        ])),
        section(3, vec([u32leb(0)])),
        section(7, vec([Buffer.concat([str('chain'), Buffer.from([0x00]), u32leb(0)])])),
        section(10, vec([Buffer.concat([u32leb(body.length), body])])),
    ]);
}

// Integer registers a region reads or writes. Everything written is also
// loaded at entry, so flushing the written set is exact on every path.
function regionRegisters(region) {
    const used = new Set();
    const written = new Set();
    const rd = (w) => (w >>> 7) & 0x1f;
    const rs1 = (w) => (w >>> 15) & 0x1f;
    const rs2 = (w) => (w >>> 20) & 0x1f;
    for (const block of region.blocks) {
        for (const insn of block.insns) {
            const w = insn.word;
            switch (w & 0x7f) {
                case 0x33: case 0x3b:
                    used.add(rs1(w)); used.add(rs2(w)); written.add(rd(w)); break;
                case 0x13: case 0x1b: case 0x03: case 0x67:
                    used.add(rs1(w)); written.add(rd(w)); break;
                case 0x23: case 0x63:
                    used.add(rs1(w)); used.add(rs2(w)); break;
                case 0x37: case 0x17: case 0x6f:
                    written.add(rd(w)); break;
                case 0x0f:
                    break;
                default:
                    // jit_step helpers (AMO, FP): conservative.
                    used.add(rs1(w)); used.add(rs2(w)); used.add(rd(w));
                    written.add(rd(w));
                    break;
            }
        }
    }
    for (const r of written) used.add(r);
    used.delete(0);
    written.delete(0);
    const sorted = (set) => Array.from(set).sort((a, b) => a - b);
    return { used: sorted(used), written: sorted(written) };
}

// Locals: x1..x31 (i64), n/entry/block/tmp/status (i32), vaddr/tmp64/
// tmp64b/tag (i64), then the i32 pairs of same-page access groups.
function regionLocals(extraI32) {
    const groups = [
        Buffer.concat([u32leb(31), Buffer.from([VAL.i64])]),
        Buffer.concat([u32leb(5), Buffer.from([VAL.i32])]),
        Buffer.concat([u32leb(4), Buffer.from([VAL.i64])]),
    ];
    if (extraI32 > 0) groups.push(Buffer.concat([u32leb(extraI32), Buffer.from([VAL.i32])]));
    return vec(groups);
}

function buildModuleMany(regions, options = {}) {
    if (regions.length === 0) throw new Error('no regions');
    const bodies = regions.map((region) => {
        const em = new RegionEmitter(region, options);
        const body = em.emit();
        return { body, extraI32: em.extraI32 };
    });

    const types = vec([
        funcType([VAL.i32, VAL.i64, VAL.i32, VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64], []),
        funcType([VAL.i32, VAL.i32], []),
        funcType([VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64, VAL.i64, VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64, VAL.i32], [VAL.i32]),
    ]);

    const imports = vec([
        Buffer.concat([str('env'), str('memory'), Buffer.from([0x02, 0x00]), u32leb(1)]),
        Buffer.concat([str('env'), str('regs_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('tlb_read_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('tlb_write_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('cycles_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('page_gen_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('pc_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('load_val_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        ...(options.tlbTag
            ? [Buffer.concat([str('env'), str('tlb_tag_ptr'), Buffer.from([0x03, VAL.i32, 0x00])])]
            : []),

        Buffer.concat([str('env'), str('jit_set_pc'), Buffer.from([0x00]), u32leb(1)]),
        Buffer.concat([str('env'), str('jit_sub_cycles'), Buffer.from([0x00]), u32leb(2)]),
        Buffer.concat([str('env'), str('jit_step'), Buffer.from([0x00]), u32leb(3)]),
        Buffer.concat([str('env'), str('jit_store'), Buffer.from([0x00]), u32leb(4)]),
        Buffer.concat([str('env'), str('jit_load'), Buffer.from([0x00]), u32leb(5)]),
        Buffer.concat([str('env'), str('jit_chain'), Buffer.from([0x00]), u32leb(0)]),
    ]);

    const functions = vec(bodies.map(() => u32leb(0)));
    const exports = vec(bodies.map((_, i) => Buffer.concat([
        str(options.exportPrefix ? `${options.exportPrefix}${i}` : `region_${i}`),
        Buffer.from([0x00]),
        u32leb(DEFINED_FUNC + i),
    ])));

    const codeSection = vec(bodies.map(({ body, extraI32 }) => {
        const code = Buffer.concat([regionLocals(extraI32), body]);
        return Buffer.concat([u32leb(code.length), code]);
    }));

    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        section(1, types),
        section(2, imports),
        section(3, functions),
        section(7, exports),
        section(10, codeSection),
        nameSection(regions),
    ]);
}

// Custom "name" section: region functions show up as jit_<entry offset> in
// V8 profiles instead of anonymous wasm-function[N].
function nameSection(regions) {
    const names = vec(regions.map((r, i) => Buffer.concat([
        u32leb(DEFINED_FUNC + i), str(`jit_${r.entryOff.toString(16)}`),
    ])));
    const sub = Buffer.concat([Buffer.from([1]), u32leb(names.length), names]);
    return section(0, Buffer.concat([str('name'), sub]));
}

function buildModule(region, options = {}) {
    const emitter = new RegionEmitter(region, options);
    const body = emitter.emit();
    const extraI32 = emitter.extraI32;

    const types = vec([
        funcType([VAL.i32, VAL.i64, VAL.i32, VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64], []),
        funcType([VAL.i32, VAL.i32], []),
        funcType([VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64, VAL.i64, VAL.i32], [VAL.i32]),
        funcType([VAL.i32, VAL.i64, VAL.i32], [VAL.i32]),
    ]);

    const imports = vec([
        // memory
        Buffer.concat([str('env'), str('memory'), Buffer.from([0x02, 0x00]), u32leb(1)]),
        // globals
        Buffer.concat([str('env'), str('regs_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('tlb_read_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('tlb_write_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('cycles_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('page_gen_base'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('pc_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        Buffer.concat([str('env'), str('load_val_ptr'), Buffer.from([0x03, VAL.i32, 0x00])]),
        ...(options.tlbTag
            ? [Buffer.concat([str('env'), str('tlb_tag_ptr'), Buffer.from([0x03, VAL.i32, 0x00])])]
            : []),

        // functions
        Buffer.concat([str('env'), str('jit_set_pc'), Buffer.from([0x00]), u32leb(1)]),
        Buffer.concat([str('env'), str('jit_sub_cycles'), Buffer.from([0x00]), u32leb(2)]),
        Buffer.concat([str('env'), str('jit_step'), Buffer.from([0x00]), u32leb(3)]),
        Buffer.concat([str('env'), str('jit_store'), Buffer.from([0x00]), u32leb(4)]),
        Buffer.concat([str('env'), str('jit_load'), Buffer.from([0x00]), u32leb(5)]),
        Buffer.concat([str('env'), str('jit_chain'), Buffer.from([0x00]), u32leb(0)]),
    ]);

    const functions = vec([u32leb(0)]);
    const exports = vec([
        Buffer.concat([str('region'), Buffer.from([0x00]), u32leb(DEFINED_FUNC)]),
    ]);

    // Locals: 31 x i64 (x1..x31), 4 x i32 (n, entry, block, tmp),
    // 3 x i64 (vaddr, tmp64, tmp64b).
    const code = Buffer.concat([regionLocals(extraI32), body]);
    const codeSection = vec([Buffer.concat([u32leb(code.length), code])]);

    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        section(1, types),
        section(2, imports),
        section(3, functions),
        section(7, exports),
        section(10, codeSection),
    ]);
}

module.exports = {
    buildModule, buildModuleMany, buildChainRuntime, RegionEmitter, regionRegisters, STATUS, PAGE_GEN_BITS, PAGE_GEN_MASK,
    branchOffset, jalOffset, immI, immS, PAGE_MASK,
};

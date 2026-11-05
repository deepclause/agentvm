'use strict';

// Unit tests for the region translator (docs/jit-plan.md phases 0-2). These
// run without the VM image: a small fake emulator provides linear memory, the
// TLB arrays, the cycle counter and the page-generation array.

const assert = require('node:assert');
const { buildRegion } = require('../src/jit/region');
const { buildModule, buildChainRuntime, PAGE_GEN_MASK, STATUS } = require('../src/jit/emitter');
const { compileRegion, keyFor } = require('../src/jit/compiler');
const { classify } = require('../src/jit/decode');
const ref = require('../src/riscv-ref');

const PAGE = 4096;

const encI = (rd, rs1, funct3, imm, opcode = 0x13) =>
    (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
const encR = (rd, rs1, rs2, funct3, funct7, opcode = 0x33) =>
    ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
const encS = (rs1, rs2, funct3, imm) =>
    (((((imm & 0xfff) >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) |
        (funct3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
const encB = (rs1, rs2, funct3, imm) => {
    imm &= 0x1fff;
    return ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) |
        (rs1 << 15) | (funct3 << 12) | (((imm >> 1) & 0xf) << 8) |
        (((imm >> 11) & 1) << 7) | 0x63) >>> 0;
};
const encJ = (rd, imm) => {
    imm &= 0x1fffff;
    return ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) |
        (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) |
        (rd << 7) | 0x6f) >>> 0;
};
const encJalr = (rd, rs1, imm) =>
    (((imm & 0xfff) << 20) | (rs1 << 15) | (rd << 7) | 0x67) >>> 0;

const REGS_BASE = 0x1000;
const TLB_READ = 0x2000;
const TLB_WRITE = 0x3000;
const CYCLES = 0x4000;
const PAGE_GEN = 0x5000;
const PC_PTR = 0x4100;
const LOAD_VAL = 0x4200;
const TLB_TAG = 0x4300;
const PPAGE = 3;
const GEN = 7;
const PC0 = 0x80000000n;

function pageFrom(words) {
    const page = Buffer.alloc(PAGE);
    let off = 0;
    for (const w of words) {
        if (typeof w === 'number') {
            page.writeUInt32LE(w, off);
            off += 4;
        } else if (w.size === 2) {
            page.writeUInt16LE(w.word, off);
            off += 2;
        } else {
            page.writeUInt32LE(w.word, off);
            off += 4;
        }
    }
    return page;
}

function makeEngine(page, entryOff = 0, options = {}) {
    const region = buildRegion(page, entryOff, options);
    const moduleBytes = buildModule(region, {
        inlineStores: options.inlineStores, loadHelper: options.loadHelper,
        tlbTag: options.tlbTag, tlbSize: options.tlbSize,
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    // Regions write s->pc and n_cycles directly into memory.
    const state = {
        get pc() { return view.getBigUint64(PC_PTR, true); },
        set pc(v) { view.setBigUint64(PC_PTR, BigInt.asUintN(64, BigInt(v)), true); },
        get n_cycles() { return view.getInt32(CYCLES, true); },
        set n_cycles(v) { view.setInt32(CYCLES, v, true); },
    };
    state.pc = PC0;
    state.n_cycles = options.cycles || 100000;
    const globals = {
        memory,
        regs_base: new WebAssembly.Global({ value: 'i32' }, REGS_BASE),
        tlb_read_base: new WebAssembly.Global({ value: 'i32' }, TLB_READ),
        tlb_write_base: new WebAssembly.Global({ value: 'i32' }, TLB_WRITE),
        cycles_ptr: new WebAssembly.Global({ value: 'i32' }, CYCLES),
        page_gen_base: new WebAssembly.Global({ value: 'i32' }, PAGE_GEN),
        pc_ptr: new WebAssembly.Global({ value: 'i32' }, PC_PTR),
        load_val_ptr: new WebAssembly.Global({ value: 'i32' }, LOAD_VAL),
        tlb_tag_ptr: new WebAssembly.Global({ value: 'i32' }, TLB_TAG),
        // Slow-path load: options.slowLoad(vaddr, sizeLog2) returns the value
        // or null for a fault.
        jit_load: (s, vaddr, sizeLog2) => {
            const v = options.slowLoad ? options.slowLoad(BigInt.asUintN(64, vaddr), sizeLog2) : null;
            if (v === null) return 1;
            view.setBigUint64(LOAD_VAL, BigInt.asUintN(64, v), true);
            return 0;
        },
        jit_chain: () => 0,
        jit_set_pc: (s, pc) => { state.pc = BigInt(pc); },
        jit_sub_cycles: (s, n) => { state.n_cycles -= n; },
        jit_step: () => (options.jitStep ? options.jitStep({ state, memory, view }) : 0),
        jit_store: (s, vaddr, val, sizeLog2) => {
            const v = BigInt.asUintN(64, vaddr);
            const size = 1 << sizeLog2;
            const idx = Number((v >> 12n) & 255n);
            const entry = TLB_WRITE + idx * 16;
            const tagMask = BigInt.asIntN(64, -4096n + BigInt(size - 1));
            if (view.getBigUint64(entry, true) === (v & tagMask)) {
                const host = (Number(v & 0xffffffffn) + view.getUint32(entry + 8, true)) >>> 0;
                switch (sizeLog2) {
                    case 0: view.setUint8(host, Number(val & 0xffn)); break;
                    case 1: view.setUint16(host, Number(val & 0xffffn), true); break;
                    case 2: view.setUint32(host, Number(val & 0xffffffffn), true); break;
                    default: view.setBigUint64(host, BigInt.asUintN(64, val), true); break;
                }
                return 0;
            }
            // Missing TLB: the real helper goes through the slow path.
            if (options.slowStore && options.slowStore(v, BigInt.asUintN(64, val), sizeLog2)) return 0;
            // Report "slow" so the region exits after the store.
            return 3;
        },
    };
    const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes), { env: globals });
    view.setUint32(PAGE_GEN + ((PPAGE & PAGE_GEN_MASK) << 2), GEN, true);
    return { region, instance, memory, state, view };
}

function runRegion(region, ctx, expectedGen = GEN) {
    const status = ctx.instance.exports.region(0, PC0, PPAGE, expectedGen);
    const regs = new BigInt64Array(ctx.memory.buffer, REGS_BASE, 32);
    return { status, regs: Array.from(regs).map((v) => BigInt(v)), state: ctx.state };
}

function setReg(ctx, index, value) {
    new DataView(ctx.memory.buffer).setBigUint64(REGS_BASE + index * 8, BigInt.asUintN(64, value), true);
}

function setTlb(view, base, vaddr, hostAddr) {
    const idx = Number((vaddr >> 12n) & 255n);
    const entry = base + idx * 16;
    view.setBigUint64(entry, vaddr & ~0xfffn, true);
    view.setUint32(entry + 8, (hostAddr - Number(vaddr & 0xffffffffn)) >>> 0, true);
}

let checks = 0;
function eq(name, got, want) {
    assert.strictEqual(got, want, name);
    checks++;
}

// ---------------------------------------------------------------------------
// ALU + M, compared with the independent reference interpreter.
// ---------------------------------------------------------------------------

const refMem = {
    read: () => { throw new Error('unexpected load'); },
    write: () => { throw new Error('unexpected store'); },
};

function randomAluProgram(count, withM) {
    const out = [];
    let guard = 0;
    while (out.length < count && guard++ < 20000) {
        const rd = Math.floor(Math.random() * 32);
        const rs1 = Math.floor(Math.random() * 32);
        const rs2 = Math.floor(Math.random() * 32);
        let word;
        const sel = Math.floor(Math.random() * 16);
        if (sel < 4) {
            word = encI(rd, rs1, Math.floor(Math.random() * 8), (Math.random() < 0.5 ? 1 : -1) * Math.floor(Math.random() * 2048));
        } else if (sel < 6) {
            word = encI(rd, rs1, [0, 1, 5][Math.floor(Math.random() * 3)], (Math.random() < 0.5 ? 1 : -1) * Math.floor(Math.random() * 2048), 0x1b);
        } else if (sel < 7) {
            word = ((Math.floor(Math.random() * (1 << 20)) << 12) | (rd << 7) | 0x37) >>> 0;
        } else if (sel < 8) {
            word = ((Math.floor(Math.random() * (1 << 20)) << 12) | (rd << 7) | 0x17) >>> 0;
        } else if (sel < 13) {
            word = encR(rd, rs1, rs2, Math.floor(Math.random() * 8), Math.random() < 0.5 ? 0x20 : 0);
        } else if (sel < 14) {
            word = encR(rd, rs1, rs2, [0, 1, 5][Math.floor(Math.random() * 3)], Math.random() < 0.5 ? 0x20 : 0, 0x3b);
        } else if (withM) {
            word = encR(rd, rs1, rs2, Math.floor(Math.random() * 8), 1);
        } else {
            word = encR(rd, rs1, rs2, [0, 1, 5][Math.floor(Math.random() * 3)], 0, 0x3b);
        }
        const kind = classify(word).kind;
        if (kind === 'alu' || kind === 'lui' || kind === 'auipc') out.push(word);
    }
    return out;
}

function aluFuzz(iterations, withM) {
    for (let iter = 0; iter < iterations; iter++) {
        const words = randomAluProgram(10 + Math.floor(Math.random() * 20), withM);
        const page = pageFrom(words);
        const ctx = makeEngine(page);
        if (ctx.region.totalInsns !== words.length) continue;
        const init = [];
        for (let i = 0; i < 32; i++) init[i] = 0n;
        for (let i = 1; i < 32; i++) {
            const v = (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) |
                BigInt(Math.floor(Math.random() * 0x100000000));
            init[i] = BigInt.asIntN(64, v);
        }
        for (let i = 1; i < 32; i++) setReg(ctx, i, init[i]);
        const result = runRegion(ctx.region, ctx);
        const regs = init.slice();
        const r = ref.run(words, words.map(() => 4), regs, refMem, PC0);
        if (r && r.fault) throw new Error('reference faulted on ALU program');
        for (let i = 0; i < 32; i++) {
            assert.strictEqual(result.regs[i], regs[i],
                `ALU mismatch iter=${iter} x${i}: got ${result.regs[i]} want ${regs[i]}\n${words.map((w) => w.toString(16)).join(' ')}`);
        }
    }
    checks++;
}

function shiftTest() {
    // RV64 shift amounts 32..63 set bit 5 of shamt, which also sets bit 0 of
    // the funct7 field. The translator must accept those encodings.
    const cases = [
        { name: 'slli 40', word: encI(1, 2, 1, 40), init: 1n, want: 1n << 40n },
        { name: 'srli 40', word: encI(1, 2, 5, 40), init: 1n << 40n, want: 1n },
        { name: 'srai 40', word: encI(1, 2, 5, 0x400 | 40), init: -1n << 40n, want: -1n },
        { name: 'slliw 31', word: encI(1, 2, 1, 31, 0x1b), init: 1n, want: 0xffffffff80000000n },
        { name: 'sraiw 31', word: encI(1, 2, 5, 0x400 | 31, 0x1b), init: 0xffffffff80000000n, want: -1n },
    ];
    for (const c of cases) {
        const ctx = makeEngine(pageFrom([c.word]));
        setReg(ctx, 2, c.init);
        const r = runRegion(ctx.region, ctx);
        eq(c.name, r.regs[1], BigInt.asIntN(64, c.want));
    }
}

// ---------------------------------------------------------------------------
// Branches, loops, budget and exits.
// ---------------------------------------------------------------------------

function branchLoopTest() {
    const words = [
        encI(1, 0, 0, 0),       // x1 = 0
        encI(2, 0, 0, 10),      // x2 = 10
        encI(1, 1, 0, 1),       // loop: x1++
        encI(2, 2, 0, -1),      //      x2--
        encB(2, 0, 1, -8),      //      bne x2, x0, loop
        encI(3, 1, 0, 0),       // x3 = x1
        encJ(4, 8),             // jal x4, +8
        encI(5, 0, 0, 111),     // skipped
        encI(6, 0, 0, 222),     // target (outside this region's call exit)
    ];
    const ctx = makeEngine(pageFrom(words));
    const r = runRegion(ctx.region, ctx);
    eq('loop status', r.status, STATUS.CONTINUE);
    eq('loop x1', r.regs[1], 10n);
    eq('loop x2', r.regs[2], 0n);
    eq('loop x3', r.regs[3], 10n);
    eq('loop link', r.regs[4], PC0 + 28n);
    eq('loop pc', r.state.pc, PC0 + 32n);
    eq('loop cycles', BigInt(r.state.n_cycles), 100000n - 34n);
}

function budgetTest() {
    const words = [
        encI(1, 0, 0, 0),
        encI(2, 0, 0, 100),
        encI(1, 1, 0, 1),
        encI(2, 2, 0, -1),
        encB(2, 0, 1, -8),
    ];
    const ctx = makeEngine(pageFrom(words), 0, { cycles: 10 });
    const r = runRegion(ctx.region, ctx);
    eq('budget status', r.status, STATUS.BUDGET);
    assert.ok(r.state.n_cycles <= 0, 'budget leaves n_cycles <= 0');
    assert.ok(r.state.pc >= PC0 && r.state.pc < PC0 + 20n, 'budget resumes in region');
    checks++;
}

function jalrTest() {
    const words = [encJalr(2, 1, 0)]; // jalr x2, x1, 0
    const ctx = makeEngine(pageFrom(words));
    setReg(ctx, 1, PC0 + 0x20n);
    const r = runRegion(ctx.region, ctx);
    eq('jalr status', r.status, STATUS.CONTINUE);
    eq('jalr pc', r.state.pc, PC0 + 0x20n);
    eq('jalr link', r.regs[2], PC0 + 4n);

    // The target is a separate region in the same page.
    const words2 = [encJalr(2, 1, 0), encI(3, 0, 0, 7)];
    const ctx2 = makeEngine(pageFrom(words2));
    setReg(ctx2, 1, PC0 + 4n);
    const r2 = runRegion(ctx2.region, ctx2);
    eq('jalr target pc', r2.state.pc, PC0 + 4n);
}

// ---------------------------------------------------------------------------
// Loads and stores: inline TLB hit, precise bail on a miss.
// ---------------------------------------------------------------------------

function memoryTest(inlineStores = true) {
    const words = [
        encI(1, 0, 0, 0x100),   // x1 = 0x100
        encI(2, 0, 0, 0x55),    // x2 = 0x55
        encS(1, 2, 3, 0),       // sd x2, 0(x1)
        encI(3, 1, 3, 0, 0x03), // ld x3, 0(x1)
        encI(4, 3, 0, 1),       // x4 = x3 + 1
    ];
    const page = pageFrom(words);
    const ctx = makeEngine(page, 0, { inlineStores });
    const host = 0x200;
    setTlb(ctx.view, TLB_READ, 0x100n, host);
    setTlb(ctx.view, TLB_WRITE, 0x100n, host);
    const r = runRegion(ctx.region, ctx);
    eq('mem status', r.status, STATUS.INTERP);
    eq('mem exit pc', r.state.pc, PC0 + 20n);
    eq('mem x3', r.regs[3], 0x55n);
    eq('mem x4', r.regs[4], 0x56n);
    eq('mem store', new DataView(ctx.memory.buffer).getBigUint64(host, true), 0x55n);

    // Invalidate the write TLB only: the store must bail precisely at its PC.
    ctx.view.setBigUint64(TLB_WRITE, 0xffffffffffffffffn, true);
    const r2 = runRegion(ctx.region, ctx);
    eq('mem bail status', r2.status, STATUS.INTERP);
    eq('mem bail pc', r2.state.pc, PC0 + 12n);
}

function loadHelperTest() {
    const missAll = (ctx) => {
        for (let i = 0; i < 256; i++) ctx.view.setBigUint64(TLB_READ + i * 16, 0xffffffffffffffffn, true);
        return ctx;
    };
    const words = [
        encI(1, 0, 0, 0x100),   // x1 = 0x100
        encI(3, 1, 0, 0, 0x03), // lb x3, 0(x1)
        encI(4, 3, 0, 1),       // x4 = x3 + 1
    ];
    const page = pageFrom(words);
    // Read-TLB miss, slow path returns 0xff: lb sign-extends, region goes on.
    const ctx = missAll(makeEngine(page, 0, { slowLoad: (va, sz) => (va === 0x100n && sz === 0 ? 0x12ffn : null) }));
    const r = runRegion(ctx.region, ctx);
    eq('load helper status', r.status, STATUS.INTERP);
    eq('load helper ran to the end', r.state.pc, PC0 + 12n);
    eq('load helper sign-extends', r.regs[3], -1n);
    eq('load helper continues', r.regs[4], 0n);
    eq('load helper cycles', r.state.n_cycles, 100000 - 3);
    // Slow path faults: EXCEPTION at the load, the load itself counted.
    const ctx2 = missAll(makeEngine(page, 0, { slowLoad: () => null }));
    const r2 = runRegion(ctx2.region, ctx2);
    eq('load fault status', r2.status, STATUS.EXCEPTION);
    eq('load fault pc', r2.state.pc, PC0 + 4n);
    eq('load fault keeps x1', r2.regs[1], 0x100n);
    eq('load fault cycles', r2.state.n_cycles, 100000 - 2);
    // Without the helper a miss still bails precisely.
    const ctx3 = missAll(makeEngine(page, 0, { loadHelper: false }));
    const r3 = runRegion(ctx3.region, ctx3);
    eq('load bail status', r3.status, STATUS.INTERP);
    eq('load bail pc', r3.state.pc, PC0 + 4n);
}

function classifyTest() {
    const { classify } = require('../src/jit/decode');
    eq('csrr sstatus is a helper', classify(0x10002573).kind, 'helper');          // csrrs a0, sstatus, x0
    eq('csrrci sstatus,2 ends the region', classify(0x1001f573).kind, 'exit');    // csrrci a0, sstatus, 2
    eq('csrw satp ends the region', classify(0x18051073).kind, 'exit');           // csrrw x0, satp, a0
    eq('rdtime is a helper', classify(0xc0102573).kind, 'helper');                // csrrs a0, time, x0
    eq('ecall ends the region', classify(0x00000073).kind, 'exit');
}

function chainTest() {
    // Region A: addi x1, x1, 1 ; jalr x0, 0(x5)   (x5 = PC0 + 0x100)
    // Region B at PC0 + 0x100: addi x1, x1, 10 ; ecall (ends the region)
    const pageA = pageFrom([encI(1, 1, 0, 1), encJalr(0, 5, 0)]);
    const pageB = Buffer.alloc(PAGE);
    pageB.writeUInt32LE(encI(1, 1, 0, 10), 0x100);
    pageB.writeUInt32LE(0x00000073, 0x104);
    const memory = new WebAssembly.Memory({ initial: 40 });
    const view = new DataView(memory.buffer);
    const JC = 0x100000, JCGEN = 0x6000, PRIV = 0x6008, FS = 0x6010, MIP = 0x6018, MIE = 0x601c, CHAIN = 0x6020;
    const table = new WebAssembly.Table({ initial: 4, element: 'anyfunc' });
    const G = (v) => new WebAssembly.Global({ value: 'i32' }, v);
    const runtime = new WebAssembly.Instance(new WebAssembly.Module(buildChainRuntime()), {
        env: {
            memory, table, cycles_ptr: G(CYCLES), mip_ptr: G(MIP), mie_ptr: G(MIE), jc_base: G(JC),
            jc_gen_ptr: G(JCGEN), priv_ptr: G(PRIV), fs_ptr: G(FS), chain_stat_ptr: G(CHAIN),
        },
    });
    const env = {
        memory,
        regs_base: G(REGS_BASE), tlb_read_base: G(TLB_READ), tlb_write_base: G(TLB_WRITE),
        cycles_ptr: G(CYCLES), page_gen_base: G(PAGE_GEN), pc_ptr: G(PC_PTR), load_val_ptr: G(LOAD_VAL),
        jit_chain: runtime.exports.chain,
        jit_set_pc() {}, jit_sub_cycles() {}, jit_step() { return 0; }, jit_store() { return 3; }, jit_load() { return 1; },
    };
    const mk = (page, off) => new WebAssembly.Instance(new WebAssembly.Module(
        buildModule(buildRegion(page, off), { chain: true })), { env }).exports.region;
    const a = mk(pageA, 0);
    const b = mk(pageB, 0x100);
    table.set(2, b);
    view.setUint32(PAGE_GEN + ((PPAGE & PAGE_GEN_MASK) << 2), GEN, true);
    view.setUint32(JCGEN, 0x10007, true);
    view.setUint8(PRIV, 1);
    view.setUint8(FS, 0);
    const target = PC0 + 0x100n;
    const idx = ((Math.imul(Number(target >> 12n) >>> 0, 2654435761) >>> 0) & 1023) * 64 + (Number(target >> 1n) & 63);
    const ent = JC + idx * 24;
    const fill = () => {
        view.setBigUint64(ent, target, true);
        view.setUint32(ent + 8, 2, true);       // table_idx
        view.setUint32(ent + 12, PPAGE, true);  // ppage
        view.setUint32(ent + 16, GEN, true);    // expected_gen
        view.setUint16(ent + 20, 7, true);      // jc_gen (low 16 bits)
        view.setUint8(ent + 22, 1);             // priv
        view.setUint8(ent + 23, 0);             // fsbit
    };
    const run = (cycles) => {
        view.setBigUint64(REGS_BASE + 8, 0n, true);
        view.setBigUint64(REGS_BASE + 40, target, true);
        view.setInt32(CYCLES, cycles, true);
        const st = a(0, PC0, PPAGE, GEN);
        return {
            st, x1: view.getBigUint64(REGS_BASE + 8, true), pc: view.getBigUint64(PC_PTR, true),
            cycles: view.getInt32(CYCLES, true),
        };
    };
    fill();
    let r = run(1000);
    eq('chain: ran into region B', r.x1, 11n);
    eq('chain: B exits at ecall', r.pc, PC0 + 0x104n);
    eq('chain: B status', r.st, STATUS.INTERP);
    eq('chain: cycles of both regions', r.cycles, 1000 - 3);
    eq('chain: counter', view.getBigUint64(CHAIN, true), 1n);
    // Budget exhausted after A: return CONTINUE to the interpreter.
    r = run(2);
    eq('chain: budget stops chaining', r.st, STATUS.CONTINUE);
    eq('chain: budget pc', r.pc, target);
    eq('chain: budget x1', r.x1, 1n);
    // Pending interrupt: return to the interpreter loop.
    view.setUint32(MIP, 0x20, true);
    view.setUint32(MIE, 0x20, true);
    r = run(1000);
    eq('chain: interrupt stops chaining', r.st, STATUS.CONTINUE);
    eq('chain: interrupt x1', r.x1, 1n);
    view.setUint32(MIP, 0, true);
    // Stale jump-cache generation, other privilege: no chaining.
    view.setUint16(ent + 20, 6, true);
    r = run(1000);
    eq('chain: jc gen mismatch', r.st, STATUS.CONTINUE);
    fill();
    view.setUint8(ent + 22, 0);
    r = run(1000);
    eq('chain: priv mismatch', r.st, STATUS.CONTINUE);
    fill();
    view.setUint8(FS, 3); // fs != 0, entry has fsbit 0
    r = run(1000);
    eq('chain: fs mismatch', r.st, STATUS.CONTINUE);
    view.setUint8(FS, 0);
    r = run(1000);
    eq('chain: hit again', r.x1, 11n);
    // Negative entry (table_idx 0): no chaining.
    view.setUint32(ent + 8, 0, true);
    r = run(1000);
    eq('chain: negative entry', r.st, STATUS.CONTINUE);
    eq('chain: negative entry x1', r.x1, 1n);
}

function tlbTagTest() {
    // ld x3, 0(x1) ; sd x3, 8(x1) with x1 = 0x100. TLB entries are stored
    // as page ^ tag: they hit only while the region's context tag matches.
    const words = [encI(3, 1, 3, 0, 0x03), encS(1, 3, 3, 8)];
    const page = pageFrom(words);
    const run = (entryTag, curTag) => {
        const ctx = makeEngine(page, 0, { tlbTag: true, inlineStores: true, slowLoad: () => null });
        const host = 0x200;
        for (const base of [TLB_READ, TLB_WRITE]) {
            setTlb(ctx.view, base, 0x100n, host);
            const idx = 0; // vpn 0
            const e = base + idx * 16;
            ctx.view.setBigUint64(e, (0x100n & ~0xfffn) ^ entryTag, true);
        }
        ctx.view.setBigUint64(TLB_TAG, curTag, true);
        ctx.view.setBigUint64(host, 0x1234n, true);
        setReg(ctx, 1, 0x100n);
        const r = runRegion(ctx.region, ctx);
        return { r, stored: ctx.view.getBigUint64(host + 8, true) };
    };
    let t = run(0x18n, 0x18n);
    eq('tlb tag match: load hits', t.r.regs[3], 0x1234n);
    eq('tlb tag match: store hits', t.stored, 0x1234n);
    eq('tlb tag match: runs to the end', t.r.state.pc, PC0 + 8n);
    // Same page cached for another context: must miss (slow path faults here).
    t = run(0x18n, 0x08n);
    eq('tlb tag mismatch: load misses', t.r.status, STATUS.EXCEPTION);
    eq('tlb tag mismatch: no store', t.stored, 0n);
}

function coalesceFuzzTest() {
    // Random load/store runs through three base registers near a page
    // boundary (so groups sometimes cross pages), with misaligned offsets and
    // base updates. The helpers perform the access like the C slow path, so
    // the region must match the reference interpreter exactly.
    const GUEST = 0x10000n;           // two guest pages: 0x10000..0x11fff
    const HOST = 0x8000;
    const SPAN = 0x2000;
    let seed = 12345;
    const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    const loadF3 = [0, 1, 2, 3, 4, 5, 6];
    const storeF3 = [0, 1, 2, 3];
    for (let iter = 0; iter < 300; iter++) {
        const words = [];
        for (let k = 0; k < 24; k++) {
            const base = 1 + rnd(3);                  // x1..x3
            const r = rnd(10);
            if (r < 4) {
                const f3 = loadF3[rnd(7)];
                const size = [1, 2, 4, 8, 1, 2, 4][f3];
                const off = rnd(4) === 0 ? rnd(64) - 32 : (rnd(16) - 8) * size;
                const rd = rnd(4) === 0 ? base : 5 + rnd(6); // sometimes overwrite the base
                if (rd === base) continue; // keep bases in the scratch range
                words.push(encI(rd, base, f3, off, 0x03));
            } else if (r < 8) {
                const f3 = storeF3[rnd(4)];
                const size = 1 << f3;
                const off = rnd(4) === 0 ? rnd(64) - 32 : (rnd(16) - 8) * size;
                words.push(encS(base, 5 + rnd(6), f3, off));
            } else if (r < 9) {
                words.push(encI(base, base, 0, (rnd(5) - 2) * 8)); // move a base
            } else {
                words.push(encI(5 + rnd(6), 5 + rnd(6), 0, rnd(100))); // ALU noise
            }
        }
        words.push(0x00000073); // ecall: end of region
        const page = pageFrom(words);
        const flat = new Uint8Array(SPAN);
        for (let i = 0; i < SPAN; i++) flat[i] = rnd(256);
        const regs0 = new Array(32).fill(0n);
        for (const b of [1, 2, 3]) regs0[b] = GUEST + 0x1000n - 0x40n + BigInt(rnd(0x80)); // around the page boundary
        for (let r = 5; r < 11; r++) regs0[r] = BigInt.asIntN(64, BigInt(rnd(1 << 30)) * 0x1000003n);

        const inRange = (a, size) => a >= GUEST && a + BigInt(size) <= GUEST + BigInt(SPAN);
        // Reference.
        const refFlat = flat.slice();
        const mem = {
            read(addr, size, signed) {
                const a = BigInt.asUintN(64, addr);
                if (!inRange(a, size)) return null;
                let v = 0n;
                for (let i = 0; i < size; i++) v |= BigInt(refFlat[Number(a - GUEST) + i]) << BigInt(8 * i);
                return signed ? BigInt.asIntN(size * 8, v) : v;
            },
            write(addr, size, val) {
                const a = BigInt.asUintN(64, addr);
                if (!inRange(a, size)) return false;
                for (let i = 0; i < size; i++) refFlat[Number(a - GUEST) + i] = Number((val >> BigInt(8 * i)) & 0xffn);
                return true;
            },
        };
        const regs = regs0.slice();
        let pc = PC0;
        let refFault = false;
        for (let k = 0; k < words.length - 1; k++) {
            const r = ref.step(words[k], regs, mem, pc, 4n);
            if (r && r.fault) { refFault = true; break; }
            regs[0] = 0n;
            pc += 4n;
        }
        if (refFault) continue; // out-of-range access: skip this program

        // Region, with helpers that implement the slow path on `flat`.
        const ctx = makeEngine(page, 0, {
            tlbTag: true,
            slowLoad: (va, sizeLog2) => {
                const size = 1 << sizeLog2;
                if (!inRange(va, size)) return null;
                let v = 0n;
                for (let i = 0; i < size; i++) v |= BigInt(ctx.view.getUint8(HOST + Number(va - GUEST) + i)) << BigInt(8 * i);
                return v;
            },
            slowStore: (va, val, sizeLog2) => {
                const size = 1 << sizeLog2;
                if (!inRange(va, size)) return false;
                for (let i = 0; i < size; i++) ctx.view.setUint8(HOST + Number(va - GUEST) + i, Number((val >> BigInt(8 * i)) & 0xffn));
                return true;
            },
        });
        // The engine's jit_store mimics the TLB; make misses perform the store.
        for (const base of [TLB_READ, TLB_WRITE]) {
            setTlb(ctx.view, base, GUEST, HOST);
            setTlb(ctx.view, base, GUEST + 0x1000n, HOST + 0x1000);
        }
        ctx.view.setBigUint64(TLB_TAG, 0n, true);
        new Uint8Array(ctx.memory.buffer, HOST, SPAN).set(flat);
        for (let r = 1; r < 32; r++) setReg(ctx, r, regs0[r]);
        const res = runRegion(ctx.region, ctx);
        const got = new Uint8Array(ctx.memory.buffer, HOST, SPAN);
        let ok = res.state.pc === PC0 + BigInt(4 * (words.length - 1));
        for (let r = 1; r < 32 && ok; r++) if (BigInt.asUintN(64, res.regs[r]) !== BigInt.asUintN(64, regs[r])) ok = false;
        for (let i = 0; i < SPAN && ok; i++) if (got[i] !== refFlat[i]) ok = false;
        if (!ok) {
            throw new Error(`coalesce fuzz mismatch iter ${iter}: pc ${res.state.pc.toString(16)} status ${res.status}`);
        }
        checks++;
    }
}

function tlbSizeTest() {
    // ld x3, 0(x1) with x1 = 0x123000: entry 0x123 with 4096 entries,
    // entry 0x23 with 256.
    const page = pageFrom([encI(3, 1, 3, 0, 0x03), 0x00000073]);
    for (const [size, idx] of [[4096, 0x123], [256, 0x23]]) {
        const ctx = makeEngine(page, 0, { tlbSize: size, slowLoad: () => null });
        const host = 0x9000;
        // The other candidate entry must not match.
        ctx.view.setBigUint64(TLB_READ + (idx === 0x123 ? 0x23 : 0x123) * 16, 0xffffffffffffffffn, true);
        ctx.view.setBigUint64(TLB_READ + idx * 16, 0x123000n, true);
        ctx.view.setUint32(TLB_READ + idx * 16 + 8, (host - 0x123000) >>> 0, true);
        ctx.view.setBigUint64(host, 0x77n, true);
        setReg(ctx, 1, 0x123000n);
        const r = runRegion(ctx.region, ctx);
        eq(`tlb size ${size}: hits entry 0x${idx.toString(16)}`, r.regs[3], 0x77n);
    }
}

function generationTest() {
    const words = [encI(1, 0, 0, 5), encI(2, 0, 0, 6)];
    const page = pageFrom(words);
    const ctx = makeEngine(page);
    const r = runRegion(ctx.region, ctx, GEN + 1);
    eq('generation mismatch status', r.status, STATUS.INTERP);
    eq('generation mismatch leaves pc', r.state.pc, PC0);
    eq('generation mismatch does not run', r.regs[1], 0n);
    eq('generation mismatch does not charge cycles', BigInt(r.state.n_cycles), 100000n);
}

// ---------------------------------------------------------------------------
// Compressed instructions and compiler keys.
// ---------------------------------------------------------------------------

function compressedTest() {
    // c.li x5, 1 ; addi x6, x5, 1
    const page = pageFrom([{ word: 0x4285, size: 2 }, encI(6, 5, 0, 1)]);
    const ctx = makeEngine(page);
    eq('compressed region reached both insns', ctx.region.totalInsns, 2);
    const r = runRegion(ctx.region, ctx);
    eq('compressed x5', r.regs[5], 1n);
    eq('compressed x6', r.regs[6], 2n);
}

function keyTest() {
    const page = pageFrom([encI(1, 0, 0, 1)]);
    const a = compileRegion(page, 0, { priv: 1, fs: 0 });
    const b = compileRegion(page, 0, { priv: 1, fs: 0 });
    const c = compileRegion(page, 4, { priv: 1, fs: 0 });
    const d = compileRegion(page, 0, { priv: 1, fs: 1 });
    eq('key stable', a.key, b.key);
    assert.notStrictEqual(a.key, c.key);
    assert.notStrictEqual(a.key, d.key);
    eq('key function agrees', a.key, keyFor(page, 0, 1, 0));
    checks++;
}

// ---------------------------------------------------------------------------
// Engine request/install path (without a VM image).
// ---------------------------------------------------------------------------

function engineTest() {
    const { RegionJitEngine } = require('../src/jit/engine');
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    const host = 0x800;
    const pageBase = 0x10000n;
    const pageGen = 0x9000;
    const cyclesPtr = 0xa000;
    const installed = [];
    view.setInt32(cyclesPtr, 1000, true);
    view.setUint32(pageGen + ((Number(pageBase >> 12n) & PAGE_GEN_MASK) << 2), GEN, true);
    // addi x1, x0, 7 ; addi x2, x1, 1
    view.setUint32(host, encI(1, 0, 0, 7), true);
    view.setUint32(host + 4, encI(2, 1, 0, 1), true);

    const fake = {
        memory,
        jit_page_gen_ptr: () => pageGen,
        jit_paddr_to_host: (paddr) => ((BigInt(paddr) & ~0xfffn) === pageBase ? host : 0),
        jit_regs_ptr: () => REGS_BASE,
        jit_tlb_ptr: (s, which) => (which ? TLB_WRITE : TLB_READ),
        jit_cycles_ptr: () => cyclesPtr,
        jit_pc_ptr: () => cyclesPtr + 0x100,
        jit_install_region: (paddr, slot, priv, fs, gen) => {
            installed.push({ paddr: BigInt(paddr), slot, priv, fs, gen });
            return 0;
        },
        jit_region_set_enabled: () => {},
        jit_epoch_flush: () => {},
        jit_set_pc: () => {},
        jit_sub_cycles: () => {},
        jit_step: () => 0,
        jit_store: () => 0,
        jit_store_helper: () => 0,
    };
    // A funcref table with room to grow, matching the emulator build flags.
    const table = new WebAssembly.Table({ initial: 0, element: 'anyfunc', maximum: 65536 });
    fake.__indirect_function_table = table;
    const engine = new RegionJitEngine({ exports: fake, table, enabled: true, batching: false });
    engine.enable(true);

    eq('engine request installs', engine.request(0, pageBase, 0, 0, 0, GEN), 1);
    eq('engine install recorded', installed.length, 1);
    eq('engine installed paddr', installed[0].paddr, pageBase);
    eq('engine installed gen', installed[0].gen, GEN);
    eq('engine table slot', typeof table.get(installed[0].slot), 'function');

    // Same page/entry/generation is deduplicated.
    eq('engine dedup', engine.request(0, pageBase, 0, 0, 0, GEN), 0);
    eq('engine no duplicate install', installed.length, 1);

    // A changed generation recompiles and installs a fresh slot.
    view.setUint32(pageGen + ((Number(pageBase >> 12n) & PAGE_GEN_MASK) << 2), GEN + 1, true);
    eq('engine recompile after gen change', engine.request(0, pageBase, 0, 0, 0, GEN + 1), 1);
    eq('engine second install', installed.length, 2);
    eq('engine second gen', installed[1].gen, GEN + 1);

    // Batched mode: requests queue, poll() compiles them into one module.
    installed.length = 0;
    view.setUint32(host + 8, encI(3, 2, 0, 1), true); // addi x3, x2, 1
    const batched = new RegionJitEngine({ exports: fake, table, enabled: true, batching: true, async: false });
    batched.enable(true);
    eq('batch request queues', batched.request(0, pageBase, 0, 0, 0, GEN + 1), 0);
    eq('batch request queues second', batched.request(0, pageBase + 4n, 4, 0, 0, GEN + 1), 0);
    eq('batch duplicate is deduped', batched.request(0, pageBase + 4n, 4, 0, 0, GEN + 1), 0);
    eq('batch nothing installed before poll', installed.length, 0);
    batched.poll();
    eq('batch poll installs both', installed.length, 2);
    eq('batch one module', batched.stats.batches, 1);
    eq('batch entry paddrs', installed.map((e) => e.paddr).join(','), `${pageBase},${pageBase + 4n}`);
    eq('batch slots are functions', installed.every((e) => typeof table.get(e.slot) === 'function'), true);
    // A request whose page generation changed before poll is dropped.
    eq('batch stale request queues', batched.request(0, pageBase + 8n, 8, 0, 0, GEN), 0);
    batched.poll();
    eq('batch stale request dropped', installed.length, 2);

    // Thrash control: a page whose generation keeps changing is not
    // translated for a cool-down period.
    installed.length = 0;
    const thrash = new RegionJitEngine({ exports: fake, table, enabled: true, batching: false });
    thrash.enable(true);
    const genOf = () => view.getUint32(pageGen + ((Number(pageBase >> 12n) & PAGE_GEN_MASK) << 2), true);
    let g = genOf();
    eq('thrash first install', thrash.request(0, pageBase, 0, 0, 0, g), 1);
    let installedBefore = 0;
    for (let i = 0; i < 9; i++) {
        g++;
        view.setUint32(pageGen + ((Number(pageBase >> 12n) & PAGE_GEN_MASK) << 2), g, true);
        installedBefore = installed.length;
        thrash.request(0, pageBase, 0, 0, 0, g);
    }
    eq('thrash cool-down started', thrash.stats.thrashCooldowns, 1);
    eq('thrash request skipped', installed.length, installedBefore);
    eq('thrash skip counted', thrash.stats.thrashSkips >= 1, true);
    view.setUint32(pageGen + ((Number(pageBase >> 12n) & PAGE_GEN_MASK) << 2), GEN + 1, true);

    // Async: the compiler worker builds and pre-compiles the module; poll()
    // installs it once the result has arrived.
    installed.length = 0;
    const asyncEngine = new RegionJitEngine({ exports: fake, table, enabled: true, batching: true, async: true });
    asyncEngine.enable(true);
    eq('async worker started', asyncEngine.port !== null, true);
    eq('async request queues', asyncEngine.request(0, pageBase + 4n, 4, 0, 0, GEN + 1), 0);
    asyncEngine.poll(); // sends the batch
    eq('async nothing installed yet', installed.length, 0);
    eq('async in-flight dedup', asyncEngine.request(0, pageBase + 4n, 4, 0, 0, GEN + 1), 0);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 500 && installed.length === 0; i++) {
        Atomics.wait(sleeper, 0, 0, 10);
        asyncEngine.poll();
    }
    eq('async installed', installed.length, 1);
    eq('async installed paddr', installed[0].paddr, pageBase + 4n);
    eq('async slot is a function', typeof table.get(installed[0].slot), 'function');
    eq('async worker compiled', asyncEngine.stats.batchesSent, 1);
    asyncEngine.worker.terminate();
}

// ---------------------------------------------------------------------------
// Generic helper fallback (jit_step).
// ---------------------------------------------------------------------------

function helperTest() {
    // feq.s x1, f0, f0 ; addi x2, x1, 1. The helper writes x1 = 5 and advances
    // the pc; the region must reload x1 and continue with the addi.
    const fclass = 0x53; // opcode
    const feq = (((0x50 << 25) | (0 << 20) | (0 << 15) | (2 << 12) | (1 << 7) | fclass)) >>> 0;
    const page = pageFrom([feq, encI(2, 1, 0, 1)]);
    let calls = 0;
    const ctx = makeEngine(page, 0, {
        jitStep: ({ state, view }) => {
            calls++;
            view.setBigUint64(REGS_BASE + 1 * 8, 5n, true);
            state.pc += 4n;
            return 0;
        },
    });
    const r = runRegion(ctx.region, ctx);
    eq('helper called', calls, 1);
    eq('helper reloads rd', r.regs[1], 5n);
    eq('helper continues block', r.regs[2], 6n);
    eq('helper exit status', r.status, STATUS.INTERP);

    // A helper that traps returns CONTINUE with the handler PC set by
    // jit_step; the rest of the block is not executed.
    let traps = 0;
    const ctx2 = makeEngine(page, 0, {
        jitStep: ({ state }) => {
            traps++;
            state.pc = PC0 + 0x100n;
            return 1;
        },
    });
    const r2 = runRegion(ctx2.region, ctx2);
    eq('helper trap status', r2.status, STATUS.CONTINUE);
    eq('helper trap pc', r2.state.pc, PC0 + 0x100n);
    eq('helper trap skips rest', r2.regs[2], 0n);
    eq('helper trap called once', traps, 1);
}

// ---------------------------------------------------------------------------
// Diagnostics rings (Phase 0).
// ---------------------------------------------------------------------------

function diagnosticsTest() {
    const { TraceRecorder, diffTraces } = require('../src/jit/trace');
    const { GuestPcSampler } = require('../src/jit/sampler');
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ptr = 0x100;
    const state = { head: 0, enabled: false, interval: 0 };
    const exports = {
        memory,
        jit_trace_enable: (i) => { state.enabled = true; state.interval = i; state.head = 0; },
        jit_trace_disable: () => { state.enabled = false; },
        jit_trace_head: () => state.head,
        jit_trace_ptr: () => ptr,
        jit_sampler_enable: (i) => { state.enabled = true; state.interval = i; state.head = 0; },
        jit_sampler_disable: () => { state.enabled = false; },
        jit_sampler_head: () => state.head,
        jit_sampler_ptr: () => ptr,
    };
    const trace = new TraceRecorder(exports);
    eq('trace available', trace.available, true);
    trace.start(4);
    const view = new DataView(memory.buffer);
    for (let i = 0; i < 3; i++) view.setBigUint64(ptr + i * 8, BigInt(100 + i), true);
    state.head = 3;
    eq('trace drain', trace.drain().join(','), '100,101,102');
    eq('trace diff equal', diffTraces([1n, 2n], [1n, 2n]), null);
    const d = diffTraces([1n, 2n, 3n], [1n, 9n, 3n]);
    eq('trace diff index', d.index, 1);

    const sampler = new GuestPcSampler(exports);
    sampler.start(8);
    for (let i = 0; i < 3; i++) view.setBigUint64(ptr + i * 8, BigInt(0x1000 + (i === 0 ? 0 : 4)), true);
    state.head = 3;
    const samples = sampler.drain();
    eq('sampler distinct pcs', samples.length, 2);
    eq('sampler hottest', samples[0].count, 2n);
}

function main() {
    aluFuzz(120, false);
    console.log('  PASS ALU fuzz');
    aluFuzz(120, true);
    console.log('  PASS ALU+M fuzz');
    shiftTest();
    console.log('  PASS RV64 shift amounts 32..63');
    branchLoopTest();
    console.log('  PASS branches/loop');
    budgetTest();
    console.log('  PASS budget exit');
    jalrTest();
    console.log('  PASS jalr');
    memoryTest(true);
    memoryTest(false);
    loadHelperTest();
    classifyTest();
    chainTest();
    tlbTagTest();
    coalesceFuzzTest();
    tlbSizeTest();
    console.log('  PASS loads/stores');
    generationTest();
    console.log('  PASS generation invalidation');
    compressedTest();
    console.log('  PASS compressed');
    keyTest();
    console.log('  PASS compiler keys');
    engineTest();
    console.log('  PASS engine request/install');
    helperTest();
    console.log('  PASS generic helper fallback');
    diagnosticsTest();
    console.log('  PASS diagnostics rings');
    console.log(`JIT v2: ${checks} checks passed`);
}

main();

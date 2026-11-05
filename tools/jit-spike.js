'use strict';

// JIT spike: quantify the cost of the current JS-callback memory model versus
// the proposed "shared memory + inlined TLB" model, for a RISC-V-like block.
//
// This is a standalone demonstration, not production code. It emits the same
// straight-line integer/load/store block in two ways:
//
//   callback : imports env.load/env.store and calls JS for every guest access
//              (what src/jit.js does today with { externalMemory: true })
//
//   direct   : imports the shared WebAssembly.Memory, checks the TinyEMU TLB
//              in generated WASM, and performs a plain i64.load/store
//
// Usage: node tools/jit-spike.js [units] [iterations]

const { u32leb, s32leb, s64leb } = require('../src/jit.js');

function section(id, contents) {
    return Buffer.concat([Buffer.from([id]), u32leb(contents.length), contents]);
}
function str(s) {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([u32leb(b.length), b]);
}
function funcType(params, results) {
    return Buffer.concat([
        Buffer.from([0x60]),
        u32leb(params.length), Buffer.from(params),
        u32leb(results.length), Buffer.from(results),
    ]);
}

const OP = {
    i32const: 0x41, i64const: 0x42,
    localget: 0x20, localset: 0x21,
    i32add: 0x6a, i32shl: 0x74, i32and: 0x71,
    i32load: 0x28, i32load16u: 0x2b,
    i64load: 0x29, i64store: 0x37,
    i64add: 0x7c, i64sub: 0x7d, i64and: 0x83, i64shru: 0x88, i64eq: 0x51,
    wrap: 0xa7, if: 0x04, else: 0x05, end: 0x0b, call: 0x10, ret: 0x0f,
};

// Register file offsets: reg[i] at regsPtr + i*8.
// TLBEntry { u64 vaddr; u32 mem_addend; } = 16 bytes.

class BlockBuilder {
    constructor(mode) {
        this.mode = mode; // 'callback' | 'direct'
        this.code = [];
    }
    u8(...bytes) { this.code.push(Buffer.from(bytes)); }
    i32(v) { this.u8(OP.i32const); this.code.push(s32leb(v)); }
    i64(v) { this.u8(OP.i64const); this.code.push(s64leb(v)); }
    get(i) { this.u8(OP.localget, i); }
    set(i) { this.u8(OP.localset, i); }
    // reg address on stack
    regAddr(reg) {
        this.get(0);
        this.i32(reg * 8);
        this.u8(OP.i32add);
    }
    loadReg(reg) {
        this.regAddr(reg);
        this.u8(OP.i64load, 0x03, 0x00);
    }
    storeReg(reg) {
        if (reg === 0) { this.u8(0x1a, 0x1a); return; } // drop addr,val
        this.u8(OP.i64store, 0x03, 0x00);
    }

    // --- callback memory model -------------------------------------------
    // import load(statePtr:i32, addr:i64, size:i32)->i64
    // import store(statePtr:i32, addr:i64, size:i32, val:i64)->i32
    loadCb(rd, rs1, imm) {
        this.regAddr(rd);
        this.get(3);            // statePtr
        this.loadReg(rs1);
        this.i64(BigInt(imm));
        this.u8(OP.i64add);
        this.i32(8);
        this.u8(OP.call, 0x00);  // func 0 = load
        this.storeReg(rd);
    }
    storeCb(rs1, rs2, imm) {
        this.get(3);            // statePtr
        this.loadReg(rs1);
        this.i64(BigInt(imm));
        this.u8(OP.i64add);
        this.i32(8);
        this.loadReg(rs2);
        this.u8(OP.call, 0x01);  // func 1 = store
        this.u8(0x1a);           // drop i32 result
    }

    // --- direct shared-memory + inlined-TLB model -------------------------
    // locals: 0 regsPtr, 1 tlbPtr, 2 statePtr, 3 unused, 4 vaddr(i64), 5 entry(i32)
    // imports: 0 tlb_load(statePtr,addr,size)->i64, 1 tlb_store(...)->i32
    _tlbEntry(rs1, imm) {
        this.loadReg(rs1);
        if (imm) { this.i64(BigInt(imm)); this.u8(OP.i64add); }
        this.set(4);
        this.get(4);
        this.i64(12n); this.u8(OP.i64shru);
        this.i64(255n); this.u8(OP.i64and);
        this.u8(OP.wrap);
        this.i32(4); this.u8(OP.i32shl);   // *16
        this.get(1);
        this.u8(OP.i32add);
        this.set(5);
    }
    _tlbHitTest(imm) {
        // i64.load(entry) == (vaddr & ~4095)
        this.get(5);
        this.u8(OP.i64load, 0x03, 0x00);
        this.get(4);
        this.i64(-4096n);
        this.u8(OP.i64and);
        this.u8(OP.i64eq);
    }
    _hostAddr() {
        // i32.wrap(vaddr) + i32.load(entry+8)
        this.get(4); this.u8(OP.wrap);
        this.get(5); this.u8(OP.i32load, 0x02, 0x08);
        this.u8(OP.i32add);
    }
    loadDirect(rd, rs1, imm) {
        this._tlbEntry(rs1, imm);
        this._tlbHitTest(imm);
        this.u8(OP.if, 0x7e); // result i64
        this._hostAddr();
        this.u8(OP.i64load, 0x03, 0x00);
        this.u8(OP.else);
        this.get(2);
        this.get(4);
        this.i32(8);
        this.u8(OP.call, 0x00); // tlb_load
        this.u8(OP.end);
        this.set(6);            // local 6 = value
        this.regAddr(rd);
        this.get(6);
        this.storeReg(rd);
    }
    storeDirect(rs1, rs2, imm) {
        this._tlbEntry(rs1, imm);
        this._tlbHitTest(imm);
        this.u8(OP.if, 0x40); // no result
        this._hostAddr();
        this.loadReg(rs2);
        this.u8(OP.i64store, 0x03, 0x00);
        this.u8(OP.else);
        this.get(2);
        this.get(4);
        this.i32(8);
        this.loadReg(rs2);
        this.u8(OP.call, 0x01); // tlb_store
        this.u8(0x1a);
        this.u8(OP.end);
    }
    load(rd, rs1, imm) { this.mode === 'direct' ? this.loadDirect(rd, rs1, imm) : this.loadCb(rd, rs1, imm); }
    store(rs1, rs2, imm) { this.mode === 'direct' ? this.storeDirect(rs1, rs2, imm) : this.storeCb(rs1, rs2, imm); }

    // addi rd, rs1, imm
    addi(rd, rs1, imm) {
        this.regAddr(rd);
        this.loadReg(rs1);
        this.i64(BigInt(imm));
        this.u8(OP.i64add);
        this.storeReg(rd);
    }

    finish() {
        this.u8(OP.ret);
        this.u8(OP.end);
        return Buffer.concat(this.code);
    }
}

function buildModule(mode, units) {
    const b = new BlockBuilder(mode);
    // locals: 0 regsPtr, 1 tlbPtr, 2 statePtr, 3 spare, 4 vaddr i64, 5 entry i32, 6 val i64
    for (let i = 0; i < units; i++) {
        const off = (i % 60) * 8; // stay within one page
        b.load(1, 2, off);        // x1 = mem[x2 + off]
        b.addi(1, 1, i & 7);      // x1 += small constant
        b.store(2, 1, off);       // mem[x2 + off] = x1
        b.addi(3, 3, 1);          // keep a live counter
    }
    const body = Buffer.concat([
        Buffer.from([0x03, 0x01, 0x7e, 0x01, 0x7f, 0x01, 0x7e]),
        b.finish(),
    ]);
    return buildSections(mode, body);
}

function buildSections(mode, body) {
    const memImport = () => Buffer.concat([str('env'), str('memory'), Buffer.from([0x02, 0x00, 0x01])]);

    let types, imports, nImported;
    if (mode === 'callback') {
        types = Buffer.concat([
            u32leb(3),
            funcType([0x7f, 0x7f, 0x7f, 0x7f], []), // run(regs,tlb,state,dummy)
            funcType([0x7f, 0x7e, 0x7f], [0x7e]),                      // load
            funcType([0x7f, 0x7e, 0x7f, 0x7e], [0x7f]),                // store
        ]);
        imports = Buffer.concat([
            u32leb(3), memImport(),
            str('env'), str('load'), Buffer.from([0x00]), u32leb(1),
            str('env'), str('store'), Buffer.from([0x00]), u32leb(2),
        ]);
        nImported = 2;
    } else {
        types = Buffer.concat([
            u32leb(3),
            funcType([0x7f, 0x7f, 0x7f, 0x7f], []),
            funcType([0x7f, 0x7e, 0x7f], [0x7e]), // tlb_load
            funcType([0x7f, 0x7e, 0x7f, 0x7e], [0x7f]), // tlb_store
        ]);
        imports = Buffer.concat([
            u32leb(3), memImport(),
            str('env'), str('tlb_load'), Buffer.from([0x00]), u32leb(1),
            str('env'), str('tlb_store'), Buffer.from([0x00]), u32leb(2),
        ]);
        nImported = 2;
    }

    const funcSec = section(3, Buffer.concat([u32leb(1), u32leb(0)]));
    const exportSec = section(7, Buffer.concat([u32leb(1), str('run'), Buffer.from([0x00]), u32leb(nImported)]));
    const code = section(10, Buffer.concat([u32leb(1), u32leb(body.length), body]));

    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        section(1, types), section(2, imports), funcSec, exportSec, code,
    ]);
}

// ---- runtime -------------------------------------------------------------

const PAGE = 4096;
const RAM_OFF = 0x10000;
const RAM_SIZE = 0x20000;
const REGS_OFF = 0x01000;
const TLB_OFF = [0x02000, 0x03000, 0x04000]; // read, write, code
const GUEST_BASE = 0x80000000;

function setupMemory() {
    const mem = new WebAssembly.Memory({ initial: 8 });
    const view = new DataView(mem.buffer);
    // Registers: x2 = base, x5 = increment, x1 = scratch
    view.setBigUint64(REGS_OFF + 2 * 8, BigInt(GUEST_BASE), true);
    view.setBigUint64(REGS_OFF + 5 * 8, 1n, true);
    // TLB entries for pages [GUEST_BASE, GUEST_BASE + RAM_SIZE)
    for (let page = 0; page < RAM_SIZE / PAGE; page++) {
        const vaddr = BigInt(GUEST_BASE + page * PAGE);
        const idx = (Number(vaddr >> 12n)) & 255;
        const addend = (RAM_OFF + page * PAGE) - Number(vaddr);
        for (const base of TLB_OFF) {
            view.setBigUint64(base + idx * 16, vaddr, true);
            view.setUint32(base + idx * 16 + 8, addend >>> 0, true);
        }
    }
    return mem;
}

function runOne(mode, units, iterations) {
    const mem = setupMemory();
    const bytes = buildModule(mode, units);
    const module = new WebAssembly.Module(bytes);

    const stats = { slow: 0 };
    const env = { memory: mem };
    if (mode === 'callback') {
        env.load = (statePtr, addr, size) => {
            const host = RAM_OFF + (Number(BigInt.asUintN(64, addr)) - GUEST_BASE);
            return new DataView(mem.buffer).getBigUint64(host, true);
        };
        env.store = (statePtr, addr, size, val) => {
            const host = RAM_OFF + (Number(BigInt.asUintN(64, addr)) - GUEST_BASE);
            new DataView(mem.buffer).setBigUint64(host, val, true);
            return 0;
        };
    } else {
        env.tlb_load = (statePtr, addr, size) => { stats.slow++; return 0n; };
        env.tlb_store = (statePtr, addr, size, val) => { stats.slow++; return 0; };
    }
    const inst = new WebAssembly.Instance(module, { env });
    const regsPtr = REGS_OFF, tlbPtr = TLB_OFF[0], statePtr = 0, dummy = 0;

    // warmup
    for (let i = 0; i < 50; i++) inst.exports.run(regsPtr, tlbPtr, statePtr, dummy);

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) inst.exports.run(regsPtr, tlbPtr, statePtr, dummy);
    const ns = Number(process.hrtime.bigint() - t0);

    // checksum register x1 so V8 cannot elide the work
    const x1 = new DataView(mem.buffer).getBigUint64(REGS_OFF + 8, true);
    return { ns, x1, slow: stats.slow, bytes: bytes.length };
}

function main() {
    const units = Number(process.argv[2] || 400);
    const iterations = Number(process.argv[3] || 20000);
    const guestOps = units * iterations;
    console.log(`units=${units} iterations=${iterations} guestAccesses~${guestOps * 2}`);

    const cb = runOne('callback', units, iterations);
    const di = runOne('direct', units, iterations);

    const fmt = (r) => `${(r.ns / 1e6).toFixed(1)}ms  x1=${r.x1}  slow=${r.slow}  module=${r.bytes}B`;
    console.log(`callback(JS per access): ${fmt(cb)}`);
    console.log(`direct(inlined TLB)   : ${fmt(di)}`);
    console.log(`speedup               : ${(cb.ns / di.ns).toFixed(1)}x`);
    console.log(`checksum match         : ${cb.x1 === di.x1}`);
}

main();

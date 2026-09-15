'use strict';

// Validate the direct-TLB JIT memory model against a synthetic TLB + RAM.
// On a TLB miss/unaligned access the block must bail: return the high bit set
// with the exact guest PC of the faulting instruction.

const assert = require('node:assert');
const { RiscVBlockJit, BAIL_BIT, BAIL_MASK, isSupportedInstruction } = require('../src/jit');

const REGS = 0x0000;
const TLB_R = 0x0100;
const TLB_W = 0x1100;
const RAM = 0x2000;
const GUEST = 0x80000000;
const START_PC = 0x4000n;

function setup() {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const view = new DataView(memory.buffer);
    view.setBigUint64(REGS + 2 * 8, BigInt(GUEST), true); // x2 base
    const idx = (GUEST >>> 12) & 255;
    const addend = (RAM - GUEST) >>> 0;
    view.setBigUint64(TLB_R + idx * 16, BigInt(GUEST), true);
    view.setUint32(TLB_R + idx * 16 + 8, addend, true);
    view.setBigUint64(TLB_W + idx * 16, BigInt(GUEST), true);
    view.setUint32(TLB_W + idx * 16 + 8, addend, true);
    return { memory, view };
}

function runBlock(instructions, setupFn) {
    const { memory, view } = setup();
    const module = new RiscVBlockJit(instructions, null, { directTlb: true }).compile();
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    if (setupFn) setupFn(view);
    const next = instance.exports.run(REGS, TLB_R, START_PC, 0, TLB_W);
    return { next, view, memory };
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS ${name}`); }

// addi x1,x0,123 ; sd x1,0(x2) ; ld x3,0(x2)
check('store+load via direct TLB', () => {
    const { next, view } = runBlock([
        0x07b00093, // addi x1, x0, 123
        0x00113023, // sd x1, 0(x2)
        0x00013183, // ld x3, 0(x2)
    ]);
    assert.strictEqual(view.getBigInt64(REGS + 1 * 8, true), 123n, 'x1');
    assert.strictEqual(view.getBigInt64(REGS + 3 * 8, true), 123n, 'x3 loaded');
    assert.strictEqual(view.getBigInt64(RAM, true), 123n, 'RAM written directly');
    assert.strictEqual(next, START_PC + 12n, 'fall-through pc');
});

check('lw sign-extends', () => {
    const { view } = runBlock([0x00012203], (v) => v.setInt32(RAM, -5, true));
    assert.strictEqual(view.getBigInt64(REGS + 4 * 8, true), -5n, 'x4 = -5');
});

check('lbu zero-extends', () => {
    const { view } = runBlock([0x00014203], (v) => v.setUint8(RAM, 0xff));
    assert.strictEqual(view.getBigInt64(REGS + 4 * 8, true), 255n, 'x4 = 255');
});

// A read TLB miss bails with the PC of the load (offset 0).
check('read TLB miss bails at the access', () => {
    const { next, view } = runBlock(
        [0x00012203], // lw x4, 0(x2)
        (v) => v.setBigUint64(TLB_R + 0 * 16, 0n, true),
    );
    assert.strictEqual(next & BAIL_MASK, START_PC, 'bail pc');
    assert.notStrictEqual(next & BAIL_BIT, 0n, 'bail bit set');
    assert.strictEqual(view.getBigInt64(REGS + 4 * 8, true), 0n, 'x4 untouched');
});

// A write TLB miss bails and must not write RAM.
check('write TLB miss bails and leaves RAM untouched', () => {
    const { next, view } = runBlock(
        [0x00113023], // sd x1, 0(x2)
        (v) => v.setBigUint64(TLB_W + 0 * 16, 0n, true),
    );
    assert.notStrictEqual(next & BAIL_BIT, 0n, 'bail bit set');
    assert.strictEqual(view.getBigInt64(RAM, true), 0n, 'RAM untouched');
});

// Registers written before a bail must remain (precise restart).
check('register state before a bail is committed', () => {
    const { next, view } = runBlock(
        [
            0x00500093, // addi x1, x0, 5
            0x00013203, // ld x4, 0(x2)  -> miss
        ],
        (v) => v.setBigUint64(TLB_R + 0 * 16, 0n, true),
    );
    assert.strictEqual(view.getBigInt64(REGS + 1 * 8, true), 5n, 'x1 committed');
    assert.strictEqual(next & BAIL_MASK, START_PC + 4n, 'bail at the load');
});

// Unaligned access must bail (TinyEMU routes it to the slow path).
check('unaligned access bails', () => {
    const { next } = runBlock([0x00012203], (v) => {
        v.setBigUint64(REGS + 2 * 8, BigInt(GUEST + 2), true); // x2 = base+2
    });
    assert.notStrictEqual(next & BAIL_BIT, 0n, 'unaligned bails');
});

// The M extension must be rejected (it shares the OP opcode with add/sub).
check('M-extension is rejected by the validator', () => {
    const add = 0x003100b3; // add x1,x2,x3
    const sub = 0x403100b3; // sub x1,x2,x3
    const mul = 0x023100b3; // mul x1,x2,x3 (funct7=1)
    const addw = 0x003100bb;
    const mulw = 0x023100bb;
    assert(isSupportedInstruction(add));
    assert(isSupportedInstruction(sub));
    assert(!isSupportedInstruction(mul));
    assert(isSupportedInstruction(addw));
    assert(!isSupportedInstruction(mulw));
});

console.log(`direct-TLB JIT: ${passed} checks passed`);

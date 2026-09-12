'use strict';

// Scan a riscv64 ELF executable and report the instruction opcode histogram.
// This is build-time planning data for the AOT translator: it tells us which
// instructions dominate real binaries and therefore what coverage matters.

const fs = require('node:fs');

function readU64(buf, off) {
    return buf.readBigUInt64LE(off);
}
function readU32(buf, off) {
    return buf.readUInt32LE(off);
}

function scanElf(path) {
    const buf = fs.readFileSync(path);
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
        throw new Error(`${path}: not an ELF`);
    }
    if (buf[4] !== 2 || buf[5] !== 1) throw new Error(`${path}: not ELF64 little-endian`);

    const phoff = Number(readU64(buf, 0x20));
    const phentsize = buf.readUInt16LE(0x36);
    const phnum = buf.readUInt16LE(0x38);

    const op32 = new Map();
    const op16 = new Map();
    let total32 = 0;
    let total16 = 0;

    for (let i = 0; i < phnum; i++) {
        const off = phoff + i * phentsize;
        const type = readU32(buf, off);
        const flags = readU32(buf, off + 4);
        const fileOffset = Number(readU64(buf, off + 8));
        const fileSize = Number(readU64(buf, off + 32));

        // PT_LOAD (1) executable segments.
        if (type !== 1 || (flags & 1) === 0 || fileSize <= 0) continue;

        const end = Math.min(fileOffset + fileSize, buf.length);
        for (let addr = fileOffset; addr + 4 <= end;) {
            const insn = readU32(buf, addr);
            if ((insn & 3) === 3) {
                const opcode = insn & 0x7f;
                op32.set(opcode, (op32.get(opcode) || 0) + 1);
                total32++;
                addr += 4;
            } else {
                const quad = insn & 3;
                op16.set(quad, (op16.get(quad) || 0) + 1);
                total16++;
                addr += 2;
            }
        }
    }

    return { op32, op16, total32, total16 };
}

const opcodeNames = {
    0x03: 'LOAD', 0x0f: 'FENCE', 0x13: 'OP-IMM', 0x17: 'AUIPC',
    0x1b: 'OP-IMM-32', 0x23: 'STORE', 0x2f: 'AMO', 0x33: 'OP',
    0x37: 'LUI', 0x3b: 'OP-32', 0x63: 'BRANCH', 0x67: 'JALR',
    0x6f: 'JAL', 0x73: 'SYSTEM',
};

function report(path) {
    const { op32, op16, total32, total16 } = scanElf(path);
    console.log(`\n${path}`);
    console.log(`32-bit instructions: ${total32}`);
    console.log(`16-bit (compressed) instructions: ${total16}`);
    const entries = [...op32.entries()].sort((a, b) => b[1] - a[1]);
    console.log('32-bit opcode histogram:');
    for (const [op, count] of entries) {
        const pct = ((count / total32) * 100).toFixed(1);
        console.log(`  0x${op.toString(16).padStart(2, '0')} ${opcodeNames[op] || '?'} ${count} (${pct}%)`);
    }
    const compressed = [...op16.entries()].sort((a, b) => b[1] - a[1]);
    console.log('16-bit quadrant histogram:');
    for (const [quad, count] of compressed) {
        console.log(`  quadrant ${quad}: ${count}`);
    }
}

for (const file of process.argv.slice(2)) report(file);

'use strict';

// Build-time AOT compiler.
//
// Reads riscv64 ELF executables, decodes executable basic blocks, compiles
// them into one WASM module, and writes:
//   aot.wasm         - precompiled blocks (exports run_0, run_1, ...)
//   aot.index.json   - [{ vaddr, size, export }]
//
// Usage:
//   node tools/aot-compile.js out.wasm out.index.json elf1 [elf2 ...]

const fs = require('node:fs');
const { RiscVBlockJit } = require('../src/jit');
const { decodeRiscV } = require('../src/riscv-c');

const SUPPORTED = new Set([0x13, 0x1b, 0x37, 0x17, 0x6f, 0x67, 0x63]);
const TERMINAL = new Set([0x63, 0x6f, 0x67]);

function readU64(buf, off) {
    return buf.readBigUInt64LE(off);
}

function collectBlocks(elfPath) {
    const buf = fs.readFileSync(elfPath);
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
        throw new Error(`${elfPath}: not an ELF`);
    }
    if (buf[4] !== 2 || buf[5] !== 1) throw new Error(`${elfPath}: not ELF64 LE`);

    const phoff = Number(readU64(buf, 0x20));
    const phentsize = buf.readUInt16LE(0x36);
    const phnum = buf.readUInt16LE(0x38);
    const blocks = [];

    for (let i = 0; i < phnum; i++) {
        const off = phoff + i * phentsize;
        const type = buf.readUInt32LE(off);
        const flags = buf.readUInt32LE(off + 4);
        const fileOffset = Number(readU64(buf, off + 8));
        const vaddr = Number(readU64(buf, off + 16));
        const fileSize = Number(readU64(buf, off + 32));
        if (type !== 1 || (flags & 1) === 0 || fileSize <= 0) continue;

        const end = Math.min(fileOffset + fileSize, buf.length);
        let cursor = fileOffset;
        let current = null;

        const flush = () => {
            if (current && current.instructions.length > 0) {
                blocks.push(current);
            }
            current = null;
        };

        while (cursor < end) {
            const decoded = decodeRiscV(buf, cursor);
            if (!decoded) { flush(); cursor += 2; continue; }
            const word = decoded.word >>> 0;
            const opcode = word & 0x7f;
            const guestVaddr = vaddr + (cursor - fileOffset);

            if (!SUPPORTED.has(opcode)) { flush(); cursor += decoded.size; continue; }

            if (!current) {
                current = { vaddr: guestVaddr, instructions: [], sizes: [] };
            }
            current.instructions.push(word);
            current.sizes.push(decoded.size);
            cursor += decoded.size;

            if (TERMINAL.has(opcode)) flush();
        }
        flush();
    }

    return blocks;
}

async function main() {
    const outWasm = process.argv[2];
    const outIndex = process.argv[3];
    const elfs = process.argv.slice(4);
    if (!outWasm || !outIndex || elfs.length === 0) {
        console.error('usage: node tools/aot-compile.js out.wasm out.index.json elf...');
        process.exit(2);
    }

    const blocks = [];
    for (const elf of elfs) {
        const collected = collectBlocks(elf);
        console.log(`${elf}: ${collected.length} blocks`);
        blocks.push(...collected);
    }

    if (blocks.length === 0) throw new Error('no translatable blocks found');

    // Some compressed/edge encodings are not yet fully supported by the
    // decoder. AOT skips those blocks and leaves them to the interpreter.
    const good = [];
    for (const block of blocks) {
        try {
            new RiscVBlockJit(block.instructions, block.sizes).compile();
            good.push(block);
        } catch (err) {
            // skip
        }
    }
    if (good.length === 0) throw new Error('no blocks compiled successfully');
    console.log(`compiling ${good.length}/${blocks.length} blocks`);
    const bytes = RiscVBlockJit.compileManyBytes(good);
    fs.writeFileSync(outWasm, bytes);

    const index = good.map((block, i) => ({
        vaddr: block.vaddr,
        size: block.sizes.reduce((a, b) => a + b, 0),
        export: `run_${i}`,
    }));
    fs.writeFileSync(outIndex, JSON.stringify(index, null, 2));

    console.log(`wrote ${outWasm} (${bytes.length} bytes)`);
    console.log(`wrote ${outIndex} (${index.length} entries)`);

    // Smoke test: instantiate and run the first block against a register file.
    const memory = new WebAssembly.Memory({ initial: 1 });
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    const regs = new BigInt64Array(memory.buffer, 0, 32);
    const first = good[0];
    const result = instance.exports[`run_0`](0, 256, BigInt(first.vaddr));
    console.log(`smoke: run_0 -> pc=0x${result.toString(16)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

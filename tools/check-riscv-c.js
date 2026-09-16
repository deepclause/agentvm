'use strict';
// Differential check of src/riscv-c.js against the GNU assembler.
//
// Assembles a corpus of compressed instructions, expands each 16-bit encoding
// with expandCompressed(), and compares the canonical disassembly of the
// expansion with the canonical disassembly of the original. Requires
// riscv64-linux-gnu-as/objdump (build-machine only; not part of the test suite).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandCompressed } = require('../src/riscv-c');

const CORPUS = `
.option rvc
.text
.globl _start
_start:
c.addi a0, 1
c.addi a0, -1
c.li a0, 5
c.li a0, -5
c.lui a0, 1
c.addi16sp sp, 16
c.addi16sp sp, -16
c.addi4spn a0, sp, 4
c.addi4spn a0, sp, 1020
c.lw a0, 0(a1)
c.lw a0, 124(a1)
c.ld a0, 0(a1)
c.ld a0, 248(a1)
c.sw a0, 0(a1)
c.sw a0, 124(a1)
c.sd a0, 0(a1)
c.sd a0, 248(a1)
c.lwsp a0, 0(sp)
c.lwsp a0, 252(sp)
c.ldsp a0, 0(sp)
c.ldsp a0, 504(sp)
c.swsp a0, 0(sp)
c.swsp a0, 252(sp)
c.sdsp a0, 0(sp)
c.sdsp a0, 504(sp)
c.slli a0, 1
c.slli a0, 63
c.srli a0, 1
c.srli a0, 63
c.srai a0, 1
c.srai a0, 63
c.andi a0, 1
c.andi a0, -1
c.sub a0, a1
c.xor a0, a1
c.or a0, a1
c.and a0, a1
c.subw a0, a1
c.addw a0, a1
c.addiw a0, 1
c.addiw a0, -1
c.mv a0, a1
c.add a0, a1
`;

function disasm(file, extra = []) {
    return execFileSync('riscv64-linux-gnu-objdump', ['-d', '-M', 'no-aliases', ...extra, file]).toString();
}

function parse(text) {
    const out = [];
    const re = /^\s*([0-9a-f]+):\s+([0-9a-f]+)\s+([a-z][a-z0-9.]*)\s*(.*)$/;
    for (const line of text.split('\n')) {
        const m = re.exec(line);
        if (!m) continue;
        out.push({ addr: m[1], raw: m[2], op: m[3], args: m[4].replace(/\s+/g, ' ').trim() });
    }
    return out;
}

function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-c-'));
    const S = path.join(dir, 'corpus.S');
    const O = path.join(dir, 'corpus.o');
    fs.writeFileSync(S, CORPUS);
    execFileSync('riscv64-linux-gnu-as', ['-march=rv64gc', '-o', O, S]);

    const original = parse(disasm(O)).filter((i) => i.raw.length === 4);
    const expanded = [];
    for (const insn of original) {
        const raw = parseInt(insn.raw, 16);
        const w = expandCompressed(raw);
        expanded.push({ insn, word: w });
    }

    const bin = path.join(dir, 'expanded.bin');
    const buf = Buffer.alloc(expanded.length * 4);
    expanded.forEach((e, i) => buf.writeUInt32LE((e.word >>> 0) >>> 0, i * 4));
    fs.writeFileSync(bin, buf);
    const dis = parse(execFileSync('riscv64-linux-gnu-objdump',
        ['-D', '-b', 'binary', '-m', 'riscv:rv64', '-M', 'no-aliases', bin]).toString());

    const memRe = /(-?[0-9a-fx]+)\(([a-z0-9]+)\)/;
    const lastArg = (s) => { const p = s.split(','); return p[p.length - 1].trim(); };
    const isMem = (op) => /^c\.(lw|ld|sw|sd|lwsp|ldsp|swsp|sdsp)$/.test(op);
    let bad = 0, checked = 0;
    for (let i = 0; i < original.length; i++) {
        const op = original[i].op;
        const wantArgs = original[i].args;
        const gotArgs = dis[i] ? dis[i].args : '<none>';
        let ok;
        if (isMem(op)) {
            const a = memRe.exec(wantArgs), b = memRe.exec(gotArgs);
            ok = a && b && a[1] === b[1] && a[2] === b[2];
        } else if (/^c\.(addi|addiw|li|lui|andi|slli|srli|srai|addi4spn|addi16sp)$/.test(op)) {
            ok = lastArg(wantArgs) === lastArg(gotArgs);
        } else {
            // register-register: the 32-bit form repeats the destination
            const a = wantArgs.split(',').map((x) => x.trim());
            const b = gotArgs.split(',').map((x) => x.trim());
            ok = b.length === 3 && b[0] === a[0] && b[1] === a[0] && b[2] === a[1];
        }
        checked++;
        if (!ok) {
            bad++;
            console.log(`MISMATCH raw=0x${original[i].raw}  assembler="${op} ${wantArgs}"  expand="${dis[i].op} ${gotArgs}"`);
        }
    }
    console.log(`checked ${checked} compressed instructions, ${bad} mismatches`);
}

main();

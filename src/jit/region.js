'use strict';

const {
    PAGE_SIZE, PAGE_MASK, branchOffset, jalOffset, immI, immS,
    decodeAt, classify,
} = require('./decode');

const DEFAULT_MAX_INSNS = 512;
const DEFAULT_MAX_BLOCKS = 128;

function inPage(off) {
    return Number.isInteger(off) && off >= 0 && off < PAGE_SIZE;
}

function isAligned2(off) {
    return (off & 1) === 0;
}

// Build a region (a page-confined CFG) starting at `entryOff`.
//
// The result is deliberately position independent: every address is a page
// offset. The emitter turns `off - entryOff` into a PC-relative constant and
// adds the entry virtual PC supplied at run time.
function buildRegion(pageBytes, entryOff, options = {}) {
    const maxInsns = options.maxInsns || DEFAULT_MAX_INSNS;
    const maxBlocks = options.maxBlocks || DEFAULT_MAX_BLOCKS;
    const buffer = pageBytes.length >= PAGE_SIZE
        ? pageBytes.subarray(0, PAGE_SIZE)
        : pageBytes;

    const blocks = [];
    const blockByOff = new Map();
    const worklist = [];

    function queue(off) {
        if (!inPage(off) || !isAligned2(off)) return null;
        if (blockByOff.has(off)) return blockByOff.get(off);
        if (blocks.length >= maxBlocks) return null;
        const block = allocBlock(off);
        if (block) worklist.push(off);
        return block;
    }

    function allocBlock(off) {
        if (!inPage(off) || !isAligned2(off)) return null;
        if (blockByOff.has(off)) return blockByOff.get(off);
        if (blocks.length >= maxBlocks) return null;
        const block = { id: blocks.length, startOff: off, insns: [], end: null };
        blocks.push(block);
        blockByOff.set(off, block);
        return block;
    }

    allocBlock(entryOff);
    worklist.push(entryOff);

    let totalInsns = 0;

    while (worklist.length > 0) {
        const start = worklist.shift();
        const block = blockByOff.get(start);
        if (!block || block.end) continue;

        let cursor = start;
        let ended = false;

        while (!ended) {
            if (totalInsns >= maxInsns) {
                block.end = { kind: 'exit', exitOff: cursor, status: 'interp', reason: 'cap' };
                ended = true;
                break;
            }
            if (!inPage(cursor)) {
                block.end = { kind: 'exit', exitOff: cursor, status: 'continue', reason: 'page-end' };
                ended = true;
                break;
            }
            const decoded = decodeAt(buffer, cursor);
            if (!decoded) {
                block.end = { kind: 'exit', exitOff: cursor, status: 'interp', reason: 'decode' };
                ended = true;
                break;
            }
            if (decoded.off + decoded.size > PAGE_SIZE) {
                block.end = { kind: 'exit', exitOff: cursor, status: 'continue', reason: 'straddle' };
                ended = true;
                break;
            }
            const kind = classify(decoded.word);
            if (kind.kind === 'exit' || kind.kind === 'unsupported') {
                block.end = {
                    kind: 'exit', exitOff: cursor, status: 'interp',
                    reason: kind.reason || kind.kind,
                };
                ended = true;
                break;
            }

            block.insns.push(decoded);
            totalInsns++;
            const next = cursor + decoded.size;

            switch (kind.kind) {
                case 'branch': {
                    const target = cursor + branchOffset(decoded.word);
                    block.end = {
                        kind: 'branch',
                        targetOff: target,
                        fallthroughOff: next,
                        funct3: (decoded.word >>> 12) & 7,
                        rs1: (decoded.word >>> 15) & 0x1f,
                        rs2: (decoded.word >>> 20) & 0x1f,
                    };
                    if (inPage(target)) queue(target);
                    if (inPage(next)) queue(next);
                    ended = true;
                    break;
                }
                case 'jal': {
                    const rd = (decoded.word >>> 7) & 0x1f;
                    const target = cursor + jalOffset(decoded.word);
                    block.end = {
                        kind: rd === 0 ? 'jal' : 'jal-call',
                        targetOff: target,
                        rd,
                        linkOff: next,
                    };
                    if (rd === 0 && inPage(target)) queue(target);
                    ended = true;
                    break;
                }
                case 'jalr': {
                    block.end = {
                        kind: 'jalr',
                        rd: (decoded.word >>> 7) & 0x1f,
                        rs1: (decoded.word >>> 15) & 0x1f,
                        imm: immI(decoded.word),
                        linkOff: next,
                    };
                    ended = true;
                    break;
                }
                case 'nop':
                    cursor = next;
                    break;
                default:
                    cursor = next;
                    break;
            }
        }

        if (block.end && block.end.kind === 'exit' && block.end.status === 'continue' &&
            inPage(block.end.exitOff)) {
            // A block that ran off the end of the page needs no successor.
        }
    }

    return {
        entryOff,
        entryBlock: 0,
        blocks,
        totalInsns,
        pageSize: PAGE_SIZE,
    };
}

module.exports = { buildRegion, PAGE_SIZE, PAGE_MASK, immS };

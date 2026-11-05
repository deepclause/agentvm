'use strict';

// Layout of the JITStats struct in riscv_cpu.c. Keep this in sync with the C
// definition; the worker reads it directly out of linear memory.
const STAT_FIELDS = [
    'dispatches', 'jumpHits', 'jumpMisses', 'regionCalls',
    'exitsContinue', 'exitsException', 'exitsBudget', 'exitsInterp',
    'requests', 'installs', 'installRejects', 'invalidations',
    'watchMarks', 'flushAll', 'chained',
];

const STAT_BYTES = STAT_FIELDS.length * 8;

function readStats(memory, ptr) {
    const out = {};
    if (!ptr) return out;
    const base = ptr >>> 0;
    const view = new DataView(memory.buffer);
    for (let i = 0; i < STAT_FIELDS.length; i++) {
        out[STAT_FIELDS[i]] = view.getBigUint64(base + i * 8, true).toString();
    }
    return out;
}

function formatStats(stats) {
    const lines = [];
    for (const name of STAT_FIELDS) {
        if (stats[name] !== undefined) lines.push(`${name}: ${stats[name]}`);
    }
    return lines.join('\n');
}

// Host-side compile/install counters. These complement the emulator counters
// (which describe what happened inside the guest CPU loop).
class HostJitStats {
    constructor() {
        this.reset();
    }
    reset() {
        this.requests = 0;
        this.deduped = 0;
        this.compiledRegions = 0;
        this.compiledInsns = 0;
        this.installs = 0;
        this.installRejects = 0;
        this.compileNs = 0n;
        this.instantiateNs = 0n;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.epochFlushes = 0;
        this.liveRegions = 0;
        this.batches = 0;
        this.batchesSent = 0;
        this.thrashSkips = 0;
        this.thrashCooldowns = 0;
        this.workerCodegenNs = 0n;
        this.workerCompileNs = 0n;
    }
    snapshot() {
        return {
            requests: this.requests,
            deduped: this.deduped,
            compiledRegions: this.compiledRegions,
            compiledInsns: this.compiledInsns,
            installs: this.installs,
            installRejects: this.installRejects,
            compileMs: Number(this.compileNs) / 1e6,
            instantiateMs: Number(this.instantiateNs) / 1e6,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            epochFlushes: this.epochFlushes,
            liveRegions: this.liveRegions,
            batches: this.batches,
            batchesSent: this.batchesSent,
            thrashSkips: this.thrashSkips,
            thrashCooldowns: this.thrashCooldowns,
            workerCodegenMs: Number(this.workerCodegenNs) / 1e6,
            workerCompileMs: Number(this.workerCompileNs) / 1e6,
        };
    }
}

module.exports = { STAT_FIELDS, STAT_BYTES, readStats, formatStats, HostJitStats };

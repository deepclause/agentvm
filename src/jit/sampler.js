'use strict';

const SAMPLE_RING_SIZE = 8192;

// Reads the emulator's guest-PC sample ring. The ring is written by the
// interpreter at block boundaries (see jit_sample_tick in riscv_cpu.c) and is
// intentionally tiny: it records one PC every `interval` retired instructions.
class GuestPcSampler {
    constructor(exports, options = {}) {
        this.exports = exports;
        this.interval = options.interval || (1 << 16);
        this.lastHead = 0;
        this.samples = new Map();
    }

    get available() {
        return typeof this.exports.jit_sampler_enable === 'function';
    }

    start(interval = this.interval) {
        if (!this.available) return false;
        this.interval = interval;
        this.lastHead = 0;
        this.samples.clear();
        this.exports.jit_sampler_enable(interval);
        return true;
    }

    stop() {
        if (this.available) this.exports.jit_sampler_disable();
    }

    // Collect new samples since the previous call. Returns the delta as an
    // array of { pc, count } sorted by descending count.
    drain() {
        if (!this.available) return [];
        const head = Number(this.exports.jit_sampler_head()) >>> 0;
        const ptr = Number(this.exports.jit_sampler_ptr()) >>> 0;
        const total = head - this.lastHead;
        if (total <= 0) return [];
        const count = Math.min(total, SAMPLE_RING_SIZE);
        const start = head - count;
        const view = new DataView(this.exports.memory.buffer);
        for (let i = 0; i < count; i++) {
            const idx = (start + i) & (SAMPLE_RING_SIZE - 1);
            const pc = view.getBigUint64(ptr + idx * 8, true);
            const key = pc.toString();
            this.samples.set(key, (this.samples.get(key) || 0n) + 1n);
        }
        this.lastHead = head;
        return this.snapshot();
    }

    snapshot() {
        return [...this.samples.entries()]
            .map(([pc, count]) => ({ pc: BigInt(pc), count }))
            .sort((a, b) => (a.count === b.count ? 0 : a.count > b.count ? -1 : 1));
    }
}

// Map sampled guest PCs to /proc/<pid>/maps style ranges. `maps` is an array
// of { start, end, name } with BigInt bounds.
function symbolize(pc, maps) {
    for (const m of maps) {
        if (pc >= m.start && pc < m.end) return m.name;
    }
    return null;
}

module.exports = { GuestPcSampler, symbolize, SAMPLE_RING_SIZE };

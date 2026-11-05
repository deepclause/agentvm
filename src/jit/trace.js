'use strict';

const TRACE_RING_SIZE = 4096;

// Deterministic replay trace: the emulator records hash(pc, x[]) every
// `interval` retired instructions. Two runs (JIT off/on) can then be compared
// instruction-for-instruction without storing full register files.
class TraceRecorder {
    constructor(exports, options = {}) {
        this.exports = exports;
        this.interval = options.interval || (1 << 20);
        this.lastHead = 0;
    }

    get available() {
        return typeof this.exports.jit_trace_enable === 'function';
    }

    start(interval = this.interval) {
        if (!this.available) return false;
        this.interval = interval;
        this.lastHead = 0;
        this.exports.jit_trace_enable(interval);
        return true;
    }

    stop() {
        if (this.available) this.exports.jit_trace_disable();
    }

    head() {
        return this.available ? Number(this.exports.jit_trace_head()) >>> 0 : 0;
    }

    drain() {
        if (!this.available) return [];
        const head = this.head();
        const total = head - this.lastHead;
        if (total <= 0) return [];
        const count = Math.min(total, TRACE_RING_SIZE);
        const start = head - count;
        const ptr = Number(this.exports.jit_trace_ptr()) >>> 0;
        const view = new DataView(this.exports.memory.buffer);
        const out = [];
        for (let i = 0; i < count; i++) {
            const idx = (start + i) & (TRACE_RING_SIZE - 1);
            out.push(view.getBigUint64(ptr + idx * 8, true));
        }
        this.lastHead = head;
        return out;
    }
}

// Compare two trace hash sequences. Returns null when they match, otherwise
// the first divergence with a human-readable index.
function diffTraces(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return { index: i, expected: a[i], actual: b[i] };
    }
    if (a.length !== b.length) {
        return { index: n, expected: a[n], actual: b[n], lengthMismatch: true };
    }
    return null;
}

module.exports = { TraceRecorder, diffTraces, TRACE_RING_SIZE };

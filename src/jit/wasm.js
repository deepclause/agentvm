'use strict';

// Small binary WebAssembly writer shared by the region translator.
// Everything here is deliberately dependency free: the translator runs in the
// emulator worker and in the (future) compiler worker, and must not pull in a
// large codegen dependency.

function u32leb(value) {
    const out = [];
    let v = value >>> 0;
    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v !== 0) byte |= 0x80;
        out.push(byte);
    } while (v !== 0);
    return Buffer.from(out);
}

function s32leb(value) {
    const out = [];
    let v = value | 0;
    for (;;) {
        let byte = v & 0x7f;
        v >>= 7;
        if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    return Buffer.from(out);
}

function s64leb(value) {
    const out = [];
    let v = BigInt.asIntN(64, BigInt(value));
    for (;;) {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    return Buffer.from(out);
}

function bytes(...values) {
    return Buffer.from(values.flat());
}

function concat(parts) {
    return Buffer.concat(parts);
}

function str(s) {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([u32leb(b.length), b]);
}

function section(id, contents) {
    return Buffer.concat([Buffer.from([id]), u32leb(contents.length), contents]);
}

function vec(items) {
    return Buffer.concat([u32leb(items.length), ...items]);
}

function funcType(params, results) {
    return Buffer.concat([
        Buffer.from([0x60]),
        vec(params.map((t) => Buffer.from([t]))),
        vec(results.map((t) => Buffer.from([t]))),
    ]);
}

const VAL = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, funcref: 0x70 };

// A tiny instruction stream builder with label depth tracking. The region
// translator only needs a handful of constructs, but keeping the depth
// bookkeeping in one place avoids the usual hand-written-LEB mistakes.
class Code {
    // Bytes go into a growable Uint8Array: allocating a Buffer (or growing a
    // JS array) per opcode dominated translation time.
    constructor() {
        this.buf = new Uint8Array(8192);
        this.len = 0;
        // Structural nesting level (block/loop/if minus end), used for
        // branch depths.
        this.depth = 0;
    }
    reserve(n) {
        if (this.len + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.len + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    push1(b) {
        if (this.len === this.buf.length) this.reserve(1);
        this.buf[this.len++] = b;
    }
    raw(bytes) {
        this.reserve(bytes.length);
        this.buf.set(bytes, this.len);
        this.len += bytes.length;
        return this;
    }
    u8(...v) {
        this.reserve(v.length);
        for (let i = 0; i < v.length; i++) this.buf[this.len++] = v[i] & 0xff;
        return this;
    }
    uleb(value) {
        let v = value >>> 0;
        this.reserve(5);
        const b = this.buf;
        do {
            let byte = v & 0x7f;
            v >>>= 7;
            if (v !== 0) byte |= 0x80;
            b[this.len++] = byte;
        } while (v !== 0);
        return this;
    }
    opU(op, value) {
        this.reserve(6);
        this.buf[this.len++] = op;
        return this.uleb(value);
    }
    i32(value) {
        this.reserve(6);
        const b = this.buf;
        b[this.len++] = 0x41;
        let v = value | 0;
        for (;;) {
            const byte = v & 0x7f;
            v >>= 7;
            if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
                b[this.len++] = byte;
                return this;
            }
            b[this.len++] = byte | 0x80;
        }
    }
    i64(value) {
        this.reserve(11);
        const b = this.buf;
        b[this.len++] = 0x42;
        let v = BigInt.asIntN(64, BigInt(value));
        // Small constants (the common case) avoid BigInt arithmetic.
        if (v >= -(1n << 31n) && v < (1n << 31n)) {
            let n = Number(v);
            for (;;) {
                const byte = n & 0x7f;
                n >>= 7;
                if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
                    b[this.len++] = byte;
                    return this;
                }
                b[this.len++] = byte | 0x80;
            }
        }
        for (;;) {
            const byte = Number(v & 0x7fn);
            v >>= 7n;
            if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
                b[this.len++] = byte;
                return this;
            }
            b[this.len++] = byte | 0x80;
        }
    }
    localGet(i) { return this.opU(0x20, i); }
    localSet(i) { return this.opU(0x21, i); }
    localTee(i) { return this.opU(0x22, i); }
    globalGet(i) { return this.opU(0x23, i); }
    call(i) { return this.opU(0x10, i); }
    br(depth) { return this.opU(0x0c, depth); }
    brIf(depth) { return this.opU(0x0d, depth); }
    brTable(depths, def) {
        this.push1(0x0e);
        this.uleb(depths.length);
        for (const d of depths) this.uleb(d);
        return this.uleb(def);
    }
    // Opcodes with no immediates (and block types after block/loop/if).
    op(...opcodes) {
        const o = opcodes[0];
        if (o === 0x02 || o === 0x03 || o === 0x04) this.depth++;
        else if (o === 0x0b) this.depth--;
        return this.u8(...opcodes);
    }
    // memory access: opcode, align, offset
    mem(opcode, align, offset = 0) {
        this.reserve(2);
        this.buf[this.len++] = opcode;
        this.buf[this.len++] = align;
        return this.uleb(offset);
    }
    finish() { return Buffer.from(this.buf.buffer, 0, this.len); }
}

const OP = {
    unreachable: 0x00,
    nop: 0x01,
    block: 0x02,
    loop: 0x03,
    if: 0x04,
    else: 0x05,
    end: 0x0b,
    return: 0x0f,

    i32eqz: 0x45,
    i32eq: 0x46,
    i32ne: 0x47,
    i32load8_u: 0x2d,
    i32load16_u: 0x2f,
    return_call_indirect: 0x13,
    i32lt_s: 0x48,
    i32lt_u: 0x49,
    i32gt_s: 0x4a,
    i32gt_u: 0x4b,
    i32le_s: 0x4c,
    i32le_u: 0x4d,
    i32ge_s: 0x4e,
    i32ge_u: 0x4f,
    i32add: 0x6a,
    i32sub: 0x6b,
    i32mul: 0x6c,
    i32and: 0x71,
    i32or: 0x72,
    i32xor: 0x73,
    i32shl: 0x74,
    i32shr_s: 0x75,
    i32shr_u: 0x76,

    i64eqz: 0x50,
    i64eq: 0x51,
    i64ne: 0x52,
    i64lt_s: 0x53,
    i64lt_u: 0x54,
    i64gt_s: 0x55,
    i64gt_u: 0x56,
    i64le_s: 0x57,
    i64le_u: 0x58,
    i64ge_s: 0x59,
    i64ge_u: 0x5a,
    i64add: 0x7c,
    i64sub: 0x7d,
    i64mul: 0x7e,
    i64div_s: 0x7f,
    i64div_u: 0x80,
    i64rem_s: 0x81,
    i64rem_u: 0x82,
    i64and: 0x83,
    i64or: 0x84,
    i64xor: 0x85,
    i64shl: 0x86,
    i64shr_s: 0x87,
    i64shr_u: 0x88,

    i32wrap_i64: 0xa7,
    i64extend_i32_s: 0xac,
    i64extend_i32_u: 0xad,

    i32load: 0x28,
    i64load: 0x29,
    i64load8_s: 0x30,
    i64load8_u: 0x31,
    i64load16_s: 0x32,
    i64load16_u: 0x33,
    i64load32_s: 0x34,
    i64load32_u: 0x35,
    i32store: 0x36,
    i64store: 0x37,
    i64store8: 0x3c,
    i64store16: 0x3d,
    i64store32: 0x3e,
};

module.exports = {
    u32leb, s32leb, s64leb, bytes, concat, str, section, vec,
    funcType, VAL, Code, OP,
};

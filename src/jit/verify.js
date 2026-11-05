'use strict';

// Lockstep verifier for installed regions (debug only, AGENTVM_JIT_V2_VERIFY=1).
//
// Every region call goes through a JS trampoline:
//   1. snapshot pc / x1..x31 / n_cycles;
//   2. run the region with a logging store helper that records the pre-image
//      of every byte it writes;
//   3. save the region's post-state, undo its stores, restore the snapshot;
//   4. re-execute the same number of instructions through jit_step (the real
//      interpreter) and compare pc, registers and the bytes the region wrote.
// The interpreter's result is kept, so the guest continues on the oracle path.

const { u32leb, str, section, vec, funcType, VAL } = require('./wasm');

const REGION_TYPE = [VAL.i32, VAL.i64, VAL.i32, VAL.i32];

function trampolineModule() {
    const types = vec([funcType(REGION_TYPE, [VAL.i32])]);
    const imports = vec([
        Buffer.concat([str('env'), str('hook'), Buffer.from([0x00]), u32leb(0)]),
    ]);
    const functions = vec([u32leb(0)]);
    const exports = vec([Buffer.concat([str('region'), Buffer.from([0x00]), u32leb(1)])]);
    const body = Buffer.from([
        0x00, // no locals
        0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3,
        0x10, 0,
        0x0b,
    ]);
    const code = vec([Buffer.concat([u32leb(body.length), body])]);
    return new WebAssembly.Module(Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        section(1, types), section(2, imports), section(3, functions),
        section(7, exports), section(10, code),
    ]));
}

class RegionVerifier {
    constructor(exports, memory, log) {
        this.e = exports;
        this.memory = memory;
        this.log = log || ((m) => require('node:fs').appendFileSync(process.env.AGENTVM_JIT_V2_VERIFY_LOG || '/tmp/jit-verify.log', m + '\n'));
        this.tramp = trampolineModule();
        this.calls = 0;
        this.mismatches = 0;
        this.maxReports = Number(process.env.AGENTVM_JIT_V2_VERIFY_REPORTS || 5);
        this.keepRegion = process.env.AGENTVM_JIT_V2_VERIFY_KEEP === 'region';
        this.cur = null; // active call log
    }

    dv() { return new DataView(this.memory.buffer); }

    tlbSize() { return Number(this.e.jit_tlb_size?.() || 256); }

    // Current data-TLB tag (0 on images without tagged TLBs).
    dataTag(statePtr) {
        if (typeof this.e.jit_tlb_tag_ptr !== 'function') return 0n;
        return this.dv().getBigUint64(Number(this.e.jit_tlb_tag_ptr(statePtr, 0)) >>> 0, true);
    }

    // Host address of a guest byte through the write TLB, then the read TLB.
    hostOf(statePtr, vaddr) {
        const dv = this.dv();
        const page = vaddr & ~0xfffn;
        const idx = Number((vaddr >> 12n) & BigInt(this.tlbSize() - 1));
        for (const which of [1, 0]) {
            const base = Number(this.e.jit_tlb_ptr(statePtr, which)) >>> 0;
            // Entries hold page ^ (context | epoch) tag on tagged-TLB builds:
            // compare the full key, since stale entries from older epochs or
            // other contexts keep plausible page bits.
            const tag = dv.getBigUint64(base + idx * 16, true);
            if (tag === (page ^ this.dataTag(statePtr))) {
                const addend = dv.getUint32(base + idx * 16 + 8, true);
                return (Number(vaddr & 0xffffffffn) + addend) >>> 0;
            }
        }
        return -1;
    }

    // Env overrides for a region instance.
    wrapEnv(env) {
        const self = this;
        const realStore = env.jit_store;
        const realStep = env.jit_step;
        const realLoad = env.jit_load;
        return Object.assign({}, env, {
            jit_store(s, vaddr, val, sizeLog2) {
                const cur = self.cur;
                if (cur) {
                    const size = 1 << sizeLog2;
                    const u = BigInt.asUintN(64, vaddr);
                    const bytes = [];
                    for (let i = 0; i < size; i++) {
                        const h = self.hostOf(s, BigInt.asUintN(64, u + BigInt(i)));
                        bytes.push(h);
                    }
                    const mem = new Uint8Array(self.memory.buffer);
                    const entry = { vaddr: u, size, val: BigInt.asUintN(64, val), pre: [] };
                    for (const h of bytes) entry.pre.push(h >= 0 ? [h, mem[h]] : null);
                    entry.preKnown = bytes.every((h) => h >= 0);
                    const rc = realStore(s, vaddr, val, sizeLog2);
                    entry.rc = rc;
                    entry.hostPre = bytes[0];
                    entry.hostPost = self.hostOf(s, u);
                    if (!entry.preKnown && rc === 0) {
                        // Pre-image unknown: the store filled the TLB just now.
                        entry.post = [];
                        for (let i = 0; i < size; i++) {
                            entry.post.push(self.hostOf(s, BigInt.asUintN(64, u + BigInt(i))));
                        }
                        cur.unknownPre++;
                    }
                    cur.stores.push(entry);
                    return rc;
                }
                return realStore(s, vaddr, val, sizeLog2);
            },
            jit_load(s, vaddr, sizeLog2) {
                const rc = realLoad(s, vaddr, sizeLog2);
                // target_read_slow enters RAM pages in the read TLB; a miss
                // afterwards means a device (MMIO) read, e.g. CLINT mtime,
                // whose value the oracle cannot reproduce.
                if (self.cur && rc === 0) {
                    const u = BigInt.asUintN(64, vaddr);
                    const dv = self.dv();
                    const idx = Number((u >> 12n) & BigInt(self.tlbSize() - 1));
                    const base = Number(self.e.jit_tlb_ptr(s, 0)) >>> 0;
                    const t = dv.getBigUint64(base + idx * 16, true);
                    if (t !== ((u & ~0xfffn) ^ self.dataTag(s))) self.cur.mmioLoads++;
                }
                return rc;
            },
            jit_step(s) {
                if (self.cur) self.cur.helperSteps++;
                return realStep(s);
            },
        });
    }

    wrap(regionFn, meta) {
        const self = this;
        const inst = new WebAssembly.Instance(this.tramp, {
            env: { hook: (s, pc, ppage, gen) => self.verifyCall(regionFn, meta, s, pc, ppage, gen) },
        });
        return inst.exports.region;
    }

    readRegs(regsPtr) {
        const dv = this.dv();
        const r = [];
        for (let i = 0; i < 32; i++) r.push(dv.getBigUint64(regsPtr + i * 8, true));
        return r;
    }

    writeRegs(regsPtr, regs) {
        const dv = this.dv();
        for (let i = 1; i < 32; i++) dv.setBigUint64(regsPtr + i * 8, regs[i], true);
    }

    verifyCall(regionFn, meta, s, pc, ppage, gen) {
        const e = this.e;
        const regsPtr = Number(e.jit_regs_ptr(s)) >>> 0;
        const cyclesPtr = Number(e.jit_cycles_ptr(s)) >>> 0;
        const pc0 = BigInt.asUintN(64, e.jit_get_pc(s));
        const regs0 = this.readRegs(regsPtr);
        const cycles0 = this.dv().getInt32(cyclesPtr, true);

        this.cur = { n: 0, stores: [], unknownPre: 0, helperSteps: 0, mmioLoads: 0 };
        let status;
        try {
            status = regionFn(s, pc, ppage, gen);
        } finally {
            var cur = this.cur;
            this.cur = null;
        }
        this.calls++;

        const pcR = BigInt.asUintN(64, e.jit_get_pc(s));
        const regsR = this.readRegs(regsPtr);
        const cyclesR = this.dv().getInt32(cyclesPtr, true);
        // Regions update n_cycles in memory directly.
        cur.n = cycles0 - cyclesR;

        if (cur.n === 0 && status === 3) return status; // gen mismatch / immediate bail

        // Region post bytes for every written host byte.
        const mem = () => new Uint8Array(this.memory.buffer);
        const postR = new Map();
        for (const st of cur.stores) {
            for (const p of st.pre) if (p) postR.set(p[0], mem()[p[0]]);
            if (st.post) for (const h of st.post) if (h >= 0) postR.set(h, mem()[h]);
        }
        if (cur.unknownPre || cur.helperSteps || cur.mmioLoads) {
            // Cannot undo safely; skip oracle comparison for this call.
            this.skipped = (this.skipped || 0) + 1;
            return status;
        }
        // Undo region stores (reverse order).
        for (let i = cur.stores.length - 1; i >= 0; i--) {
            for (const p of cur.stores[i].pre) if (p) mem()[p[0]] = p[1];
        }
        this.writeRegs(regsPtr, regs0);
        e.jit_set_pc(s, pc0);
        this.dv().setInt32(cyclesPtr, cycles0, true);

        // Oracle.
        let k = 0;
        let trapped = false;
        const trace = [];
        const budgetK = status === 1 ? cur.n + 1 : cur.n;
        while (k < budgetK) {
            const before = BigInt.asUintN(64, e.jit_get_pc(s));
            trace.push(before);
            const t = e.jit_step(s);
            if (t) { k += 2; trapped = true; break; }
            k += 1;
        }
        const pcO = BigInt.asUintN(64, e.jit_get_pc(s));
        const regsO = this.readRegs(regsPtr);
        const diffs = [];
        if (status === 1) {
            // The region stops at the faulting instruction with the exception
            // pending; jit_step has already delivered it. Compare the PC of the
            // instruction that trapped instead.
            const trapPc = trace.length ? trace[trace.length - 1] : pc0;
            if (!trapped) diffs.push('region faulted, oracle did not');
            else if (trapPc !== pcR) diffs.push(`trap pc region=0x${pcR.toString(16)} oracle=0x${trapPc.toString(16)}`);
        } else if (pcO !== pcR) {
            diffs.push(`pc region=0x${pcR.toString(16)} oracle=0x${pcO.toString(16)}`);
        }
        for (let i = 1; i < 32; i++) {
            if (regsO[i] !== regsR[i]) diffs.push(`x${i} region=0x${regsR[i].toString(16)} oracle=0x${regsO[i].toString(16)}`);
        }
        let memDiff = 0;
        for (const [h, v] of postR) {
            if (mem()[h] !== v) {
                if (memDiff < 8) diffs.push(`mem host=0x${h.toString(16)} region=${v} oracle=${mem()[h]}`);
                memDiff++;
            }
        }
        // A region EXCEPTION leaves the exception cycle to mmu_exception.
        const expectK = status === 1 ? cur.n + 1 : cur.n;
        if (k !== expectK) diffs.push(`count region=${cur.n} oracle=${k}`);

        if (diffs.length) {
            this.mismatches++;
            if (this.mismatches <= this.maxReports) {
                const lines = [
                    `[jit-verify] MISMATCH #${this.mismatches} call=${this.calls} ${meta} pc0=0x${pc0.toString(16)} status=${status} n=${cur.n} stores=${cur.stores.length} trapped=${trapped}`,
                    ...diffs.map((d) => '   ' + d),
                    '   regs0: ' + regs0.map((v, i) => `x${i}=${v.toString(16)}`).join(' '),
                    '   oracle pcs(last 40): ' + trace.slice(-40).map((p) => (p & 0xfffn).toString(16)).join(' '),
                    '   stores(first 20): ' + cur.stores.slice(0, 20).map((st) => `${st.vaddr.toString(16)}/${st.size}=${st.val.toString(16)} rc${st.rc} hpre=${st.hostPre.toString(16)} hpost=${st.hostPost.toString(16)} horacle=${this.hostOf(s, st.vaddr).toString(16)}`).join('\n     '),
                ];
                this.log(lines.join('\n'));
                try {
                    const host = Number(e.jit_paddr_to_host(BigInt(ppage) << 12n)) >>> 0;
                    require('node:fs').writeFileSync(`/tmp/jit-verify-page-${this.mismatches}.bin`,
                        Buffer.from(new Uint8Array(this.memory.buffer, host, 4096)));
                } catch {}
            }
            if (this.keepRegion) {
                // Re-apply the region's result instead of the oracle's.
                this.writeRegs(regsPtr, regsR);
                e.jit_set_pc(s, pcR);
                for (const [h, v] of postR) mem()[h] = v;
            }
        }
        // Account for the retired instructions exactly as the region did.
        // (When the oracle delivered a trap we return CONTINUE instead of
        // EXCEPTION, so charge the exception cycle mmu_exception would have.)
        this.dv().setInt32(cyclesPtr, trapped && status === 1 ? cyclesR - 1 : cyclesR, true);
        if (this.keepRegion && diffs.length) return status;
        if (trapped) return 0; // trap applied by jit_step; s->pc is the handler
        return status === 1 ? 0 : status;
    }
}

module.exports = { RegionVerifier };

// Exit profiler (debug only, AGENTVM_JIT_V2_PROFILE=1): counts region exits by
// status and, for INTERP exits, by the instruction class at the exit PC.
class RegionProfiler {
    constructor(exports, memory) {
        this.e = exports;
        this.memory = memory;
        this.tramp = trampolineModule();
        this.counts = new Map();
        this.calls = 0;
        this.insns = 0;
        const { decodeAt, classify } = require('./decode');
        this.decodeAt = decodeAt;
        this.classify = classify;
    }
    wrapEnv(env) { return env; }
    wrap(fn) {
        const self = this;
        const inst = new WebAssembly.Instance(this.tramp, {
            env: { hook: (s, pc, ppage, gen) => self.call(fn, s, pc, ppage, gen) },
        });
        return inst.exports.region;
    }
    bump(k, n = 1) { this.counts.set(k, (this.counts.get(k) || 0) + n); }
    call(fn, s, pc, ppage, gen) {
        this.statePtr = s;
        const cyclesPtr = Number(this.e.jit_cycles_ptr(s)) >>> 0;
        const dv = new DataView(this.memory.buffer);
        const c0 = dv.getInt32(cyclesPtr, true);
        const st = fn(s, pc, ppage, gen);
        const n = c0 - new DataView(this.memory.buffer).getInt32(cyclesPtr, true);
        this.calls++;
        this.insns += n;
        if (!this.byPc) this.byPc = new Map();
        const key = `${ppage}:${Number(BigInt.asUintN(64, pc) & 0xfffn)}`;
        const rec = this.byPc.get(key);
        if (rec) { rec.calls++; rec.insns += n; } else this.byPc.set(key, { calls: 1, insns: n, ppage, pc: BigInt.asUintN(64, pc) });
        // The worker's event loop is blocked by the emulator: report inline.
        if ((this.calls & 0x1fffff) === 0) this.report();
        this.bump(`status${st}`);
        if (n <= 4) this.bump(`short(n<=4) status${st}`);
        if (st === 3) {
            const epc = BigInt.asUintN(64, this.e.jit_get_pc(s));
            const off = Number(epc & 0xfffn);
            if (n === 0) { this.bump('interp: gen-mismatch/entry'); return st; }
            // The exit is on the region's page unless it ran off the end.
            if ((epc >> 12n) !== (BigInt.asUintN(64, pc) >> 12n)) { this.bump('interp: off-page'); return st; }
            const host = Number(this.e.jit_paddr_to_host(BigInt(ppage) << 12n)) >>> 0;
            const page = Buffer.from(new Uint8Array(this.memory.buffer, host, 4096));
            const d = this.decodeAt(page, off);
            if (!d) {
                const h = page.readUInt16LE(off);
                this.bump(`interp: undecodable ${(h & 3) !== 3 ? 'rvc' : 'rv32'} q${h & 3} f3=${(h >> 13) & 7}`);
                return st;
            }
            const op = d.word & 0x7f;
            const k = this.classify(d.word);
            const name = { 0x03: 'load', 0x23: 'store', 0x73: 'system', 0x0f: 'fence' }[op] || `op${op.toString(16)}`;
            this.bump(`interp: ${k.kind}/${k.reason || ''} ${name} f3=${(d.word >>> 12) & 7} f7=${d.word >>> 25}`);
        }
        return st;
    }
    report() {
        const rows = [...this.counts].sort((a, b) => b[1] - a[1]).slice(0, 30);
        const total = this.statePtr !== undefined ? Number(this.e.jit_insn_counter(this.statePtr)) : 0;
        require('node:fs').writeFileSync(process.env.AGENTVM_JIT_V2_PROFILE_OUT || '/tmp/jit-profile.txt',
            `calls ${this.calls} insns ${this.insns} avg ${(this.insns / Math.max(1, this.calls)).toFixed(1)}` +
            ` guest-total ${total} in-regions ${(100 * this.insns / Math.max(1, total)).toFixed(1)}%\n` +
            rows.map(([k, v]) => `${String(v).padStart(10)} ${k}`).join('\n') + '\n');
        if (this.byPc) {
            const top = [...this.byPc.values()].sort((a, b) => b.insns - a.insns).slice(0, 20);
            const fs = require('node:fs');
            const lines = top.map((r) => `${r.insns} insns ${r.calls} calls avg ${(r.insns / r.calls).toFixed(1)} pc 0x${r.pc.toString(16)} ppage 0x${r.ppage.toString(16)}`);
            fs.writeFileSync((process.env.AGENTVM_JIT_V2_PROFILE_OUT || '/tmp/jit-profile.txt') + '.top', lines.join('\n') + '\n');
            if (process.env.AGENTVM_JIT_V2_PROFILE_ALL === '1') {
                const all = [...this.byPc.values()].map((r) => `${r.insns} ${r.calls} 0x${r.pc.toString(16)}`);
                fs.writeFileSync((process.env.AGENTVM_JIT_V2_PROFILE_OUT || '/tmp/jit-profile.txt') + '.all', all.join('\n') + '\n');
            }
            // Page bytes of the hottest regions, for disassembly.
            for (const r of top.slice(0, 8)) {
                const host = Number(this.e.jit_paddr_to_host(BigInt(r.ppage) << 12n)) >>> 0;
                if (host) fs.writeFileSync(`/tmp/jit-hot-${r.ppage.toString(16)}.bin`, Buffer.from(new Uint8Array(this.memory.buffer, host, 4096)));
            }
        }
    }
}

module.exports.RegionProfiler = RegionProfiler;

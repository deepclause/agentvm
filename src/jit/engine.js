'use strict';

const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { compileRegion, keyFor } = require('./compiler');
const { buildRegion } = require('./region');
const { buildModuleMany, buildChainRuntime } = require('./emitter');
const { HostJitStats } = require('./stats');
const { RegionVerifier, RegionProfiler } = require('./verify');

const PAGE_SIZE = 4096;
const PAGE_MASK = PAGE_SIZE - 1;

// Numeric page key (page number, priv, fs): requests arrive at high rates,
// and BigInt -> string keys cost microseconds each.
function pageKey(paddr, priv, fs) {
    return (Math.floor(Number(paddr) / PAGE_SIZE) * 4 + (priv & 3)) * 2 + (fs ? 1 : 0);
}

// Region compiler / installer for the synchronous MVP. The emulator calls
// `request()` from `jit_request_region`; the finished region is installed into
// the emulator's indirect function table immediately. Phase 3 replaces the
// synchronous compile with a compiler worker and a MessagePort queue.
class RegionJitEngine {
    constructor(options = {}) {
        this.exports = options.exports;
        this.memory = options.memory || this.exports.memory;
        this.table = options.table;
        this.enabled = options.enabled !== false;
        this.debug = options.debug || (() => {});
        this.cache = options.cache || null;
        this.stats = options.stats || new HostJitStats();

        this.pageGenBase = Number(this.exports.jit_page_gen_ptr?.() || 0) >>> 0;
        this.tableBase = this.table ? this.table.length : 0;
        this.nextSlot = this.tableBase;
        this.tableGrowStep = options.tableGrowStep || 4096;
        // Keep the C physical map at most half full: lookups use bounded
        // linear probing, and installs into a crowded map are rejected.
        const physCapacity = Number(this.exports.jit_phys_capacity?.() || 16384);
        this.maxRegions = options.maxRegions || Math.floor(physCapacity / 2);
        this.maxInstalls = Number(process.env.AGENTVM_JIT_V2_MAX_INSTALLS || 0);

        this.installed = new Map(); // pageKey -> { gen, entries:Set, tableIdx, instance }
        this.liveRegions = 0;
        this.instances = [];
        this.failed = new Map(); // pageKey -> { gen, entryOff }
        this.epochFlushes = 0;
        // Batched install: requests are queued and compiled into one module
        // per poll (plan \u00a74.6). This removes the per-module V8 overhead
        // that otherwise dominates the cost of a region.
        this.batching = options.batching !== undefined
            ? options.batching
            : process.env.AGENTVM_JIT_V2_BATCH !== '0';
        this.batchMax = Number(process.env.AGENTVM_JIT_V2_BATCH_MAX || 1024);
        this.queue = [];
        // Thrash control (plan \u00a74.5): pages that are rewritten over and
        // over (V8 code space, pages mixing code and data) are not translated
        // for a growing cool-down period.
        this.thrash = new Map(); // pageBase -> { count, windowStart, until, backoff }
        this.thrashLimit = Number(process.env.AGENTVM_JIT_V2_THRASH_LIMIT || 8);
        this.thrashWindowMs = 1000;
        // G1a measurement: probe and request as usual, never translate.
        this.dryRun = process.env.AGENTVM_JIT_V2_DRYRUN === '1';
        // Async compile in a worker thread (default). AGENTVM_JIT_V2_ASYNC=0
        // keeps the synchronous batch path.
        this.port = null;
        const asyncWanted = options.async !== undefined
            ? options.async
            : process.env.AGENTVM_JIT_V2_ASYNC !== '0';
        if (this.batching && asyncWanted) this._startWorker();
        // Images built before jit_load_helper existed end regions on a
        // read-TLB miss instead.
        this.hasLoadHelper = typeof this.exports.jit_load_helper === 'function' &&
            typeof this.exports.jit_load_value_ptr === 'function';
        // Tagged TLB (newer images): regions fold the context tag into their
        // inline TLB compares.
        this.tlbTag = typeof this.exports.jit_tlb_tag_ptr === 'function';
        this.tlbSize = Number(this.exports.jit_tlb_size?.() || 256);
        // Same-page access coalescing (AGENTVM_JIT_V2_COALESCE=0 disables).
        this.coalesce = process.env.AGENTVM_JIT_V2_COALESCE !== '0';
        // Region chaining (opt-in, AGENTVM_JIT_V2_CHAIN=1): CONTINUE exits
        // tail-call the next region through the chain runtime. It keeps ~90%
        // of transitions in wasm but measured no wall-time gain, and the
        // verifier (JS trampolines in the table) cannot cover it, so it is
        // off by default. Needs the jump-cache addresses from the emulator.
        this.chain = typeof this.exports.jit_chain_ptr === 'function' &&
            !!this.table && process.env.AGENTVM_JIT_V2_VERIFY !== '1' &&
            (options.chain !== undefined ? !!options.chain : process.env.AGENTVM_JIT_V2_CHAIN === '1');
        this.queued = new Set();
        this.failedEntries = new Set();
        this.verifier = process.env.AGENTVM_JIT_V2_VERIFY === '1'
            ? new RegionVerifier(this.exports, this.memory, options.verifyLog)
            : (process.env.AGENTVM_JIT_V2_PROFILE === '1' ? new RegionProfiler(this.exports, this.memory) : null);
        // The profiler reuses the verifier hooks but keeps inline stores.
        this.verifyStores = process.env.AGENTVM_JIT_V2_VERIFY === '1';
    }

    enable(on) {
        const was = this.enabled;
        this.enabled = !!on;
        if (on && !was) this.flushEpoch();
        this.exports.jit_region_set_enabled?.(on ? 1 : 0);
    }

    _readPage(pageBase) {
        const host = Number(this.exports.jit_paddr_to_host(BigInt(pageBase))) >>> 0;
        if (!host) return null;
        // Copy immediately: guest stores can change the page and the memory
        // buffer can be replaced if linear memory grows.
        return Buffer.from(new Uint8Array(this.memory.buffer, host, PAGE_SIZE));
    }

    _allocSlot() {
        if (!this.table) return -1;
        if (this.nextSlot >= this.table.length) {
            try {
                this.table.grow(this.tableGrowStep);
            } catch {
                return -1;
            }
        }
        return this.nextSlot++;
    }

    // The single instance that imports the function table (see
    // buildChainRuntime for why regions must not import it).
    _chainRuntime(statePtr) {
        if (!this.chainFn) {
            const e = this.exports;
            const p = (which) => new WebAssembly.Global({ value: 'i32' },
                Number(e.jit_chain_ptr(statePtr, which)) >>> 0);
            const inst = new WebAssembly.Instance(new WebAssembly.Module(buildChainRuntime()), {
                env: {
                    memory: this.memory,
                    table: this.table,
                    cycles_ptr: new WebAssembly.Global({ value: 'i32' }, Number(e.jit_cycles_ptr(statePtr)) >>> 0),
                    mip_ptr: p(4), mie_ptr: p(5), jc_base: p(0), jc_gen_ptr: p(1),
                    priv_ptr: p(2), fs_ptr: p(3), chain_stat_ptr: p(6),
                },
            });
            this.chainFn = inst.exports.chain;
        }
        return this.chainFn;
    }

    _instantiate(compiled, statePtr) {
        const e = this.exports;
        const g = (v) => new WebAssembly.Global({ value: 'i32' }, Number(v) >>> 0);
        const env = {
            memory: this.memory,
            regs_base: g(e.jit_regs_ptr(statePtr)),
            tlb_read_base: g(e.jit_tlb_ptr(statePtr, 0)),
            tlb_write_base: g(e.jit_tlb_ptr(statePtr, 1)),
            cycles_ptr: g(e.jit_cycles_ptr(statePtr)),
            page_gen_base: g(this.pageGenBase),
            pc_ptr: g(e.jit_pc_ptr(statePtr)),
            load_val_ptr: g(this.hasLoadHelper ? e.jit_load_value_ptr() : 0),
            tlb_tag_ptr: g(this.tlbTag ? e.jit_tlb_tag_ptr(statePtr, 0) : 0),
            jit_set_pc: e.jit_set_pc,
            jit_sub_cycles: e.jit_sub_cycles,
            jit_step: e.jit_step,
            jit_store: e.jit_store_helper,
            jit_load: this.hasLoadHelper ? e.jit_load_helper : () => 1,
        };
        env.jit_chain = this.chain ? this._chainRuntime(statePtr) : () => 0;
        const module = compiled.module || new WebAssembly.Module(compiled.moduleBytes);
        return new WebAssembly.Instance(module, {
            env: this.verifier ? this.verifier.wrapEnv(env) : env,
        });
    }

    // Called from the emulator import. paddr is a BigInt (i64).
    request(statePtr, paddr, entryOff, priv, fs, expectedGen) {
        if (!this.enabled) return 0;
        if (this.maxInstalls && this.stats.installs >= this.maxInstalls) return 0;
        this.stats.requests++;

        const key = pageKey(paddr, priv, fs);
        let prior = this.installed.get(key);
        if (prior && prior.gen === expectedGen && prior.entries.has(entryOff)) {
            this.stats.deduped++;
            return 0;
        }
        const entryPaddr = BigInt(paddr);
        const pageBase = entryPaddr & ~BigInt(PAGE_MASK);
        if (prior && prior.gen !== expectedGen) {
            // The page changed under us. The emulator has already invalidated
            // the old translations; allocate a fresh slot for the new code.
            prior.entries.clear();
            prior.gen = expectedGen;
            this._noteInvalidation(key);
        }
        if (this.thrash.size !== 0 && this._coolingDown(key)) {
            this.stats.thrashSkips = (this.stats.thrashSkips || 0) + 1;
            return 0;
        }
        if (this.dryRun) return 0;
        const failed = this.failed.get(key);
        if (failed && failed.gen === expectedGen && failed.entryOff === entryOff) {
            return 0;
        }

        if (this.batching) {
            const entryKey = `${key}:${expectedGen}:${entryOff}`;
            if (this.queued.has(entryKey) || this.failedEntries.has(entryKey)) {
                this.stats.deduped++;
                return 0;
            }
            this.queued.add(entryKey);
            this.queue.push({
                statePtr, entryPaddr, pageBase, entryOff, priv, fs, expectedGen, key, entryKey,
            });
            return 0;
        }

        const pageBytes = this._readPage(pageBase);
        if (!pageBytes) return 0;

        const cacheKey = keyFor(pageBytes, entryOff, priv, fs ? 1 : 0);
        let compiled = null;
        if (this.cache && !this.verifier) {
            const cached = this.cache.get(cacheKey);
            if (cached) {
                this.stats.cacheHits++;
                compiled = {
                    moduleBytes: cached.bytes,
                    exportName: 'region',
                    key: cacheKey,
                    insnCount: cached.meta.insnCount || 1,
                    region: null,
                };
            } else {
                this.stats.cacheMisses++;
            }
        }
        if (process.env.AGENTVM_JIT_V2_DUMP === '1' && this.stats.installs === 0) {
            try {
                const fs = require('node:fs');
                fs.writeFileSync('/tmp/region-page.bin', pageBytes);
                const e = this.exports;
                const regsPtr = Number(e.jit_regs_ptr(statePtr)) >>> 0;
                const regs = [];
                const dv = new DataView(this.memory.buffer);
                for (let i = 0; i < 32; i++) regs.push('0x' + dv.getBigUint64(regsPtr + i * 8, true).toString(16));
                const tlb = [];
                for (const which of [0, 1]) {
                    const base = Number(e.jit_tlb_ptr(statePtr, which)) >>> 0;
                    for (let i = 0; i < this.tlbSize; i++) {
                        const vaddr = dv.getBigUint64(base + i * 16, true);
                        if (vaddr === 0xffffffffffffffffn) continue;
                        const addend = dv.getUint32(base + i * 16 + 8, true);
                        const host = (addend + Number(vaddr & 0xfffff000n)) >>> 0;
                        if (!host) continue;
                        tlb.push({
                            which, idx: i, vaddr: '0x' + vaddr.toString(16),
                            data: Buffer.from(new Uint8Array(this.memory.buffer, host, PAGE_SIZE)).toString('base64'),
                        });
                    }
                }
                fs.writeFileSync('/tmp/region-entry.json', JSON.stringify({
                    pc: '0x' + BigInt.asUintN(64, e.jit_get_pc(statePtr)).toString(16),
                    regs, tlb,
                }));
            } catch (err) { this.debug('dump failed ' + err.message); }
        }
        const t0 = process.hrtime.bigint();
        if (!compiled) {
            try {
                compiled = compileRegion(pageBytes, entryOff, {
                    priv, fs,
                    key: cacheKey,
                    maxInsns: 512,
                    // The lockstep verifier logs stores through the helper.
                    inlineStores: !this.verifyStores,
                    loadHelper: this.hasLoadHelper,
                    chain: this.chain,
                    tlbTag: this.tlbTag,
                    coalesce: this.coalesce,
                    tlbSize: this.tlbSize,
                });
                if (this.cache && !this.verifier) {
                    this.cache.put(cacheKey, compiled.moduleBytes, { insnCount: compiled.insnCount });
                }
            } catch (err) {
                this.failed.set(key, { gen: expectedGen, entryOff });
                this.debug(`region compile failed at 0x${entryPaddr.toString(16)}: ${err.message}`);
                return 0;
            }
        }
        const t1 = process.hrtime.bigint();
        if (compiled.insnCount === 0) {
            // The entry instruction itself needs the interpreter. Do not
            // install a do-nothing region; it would be called on every
            // dispatch to that PC.
            this.failed.set(key, { gen: expectedGen, entryOff });
            return 0;
        }
        if (process.env.AGENTVM_JIT_V2_DUMP === '1' && this.stats.installs === 0 && compiled.region) {
            try {
                require('node:fs').writeFileSync('/tmp/region.json', JSON.stringify(compiled.region, null, 2));
            } catch {}
        }
        this.stats.compiledRegions++;
        this.stats.compiledInsns += compiled.insnCount;
        this.stats.compileNs += t1 - t0;

        let slot = this._allocSlot();
        if (slot < 0) {
            this.debug('region table exhausted');
            return 0;
        }

        let instance;
        try {
            instance = this._instantiate(compiled, statePtr);
        } catch (err) {
            this.failed.set(key, { gen: expectedGen, entryOff });
            this.debug(`region instantiate failed at 0x${entryPaddr.toString(16)}: ${err.message}`);
            return 0;
        }
        const t2 = process.hrtime.bigint();
        this.stats.instantiateNs += t2 - t1;

        let fn = instance.exports[compiled.exportName];
        if (this.verifier) fn = this.verifier.wrap(fn, `paddr=0x${entryPaddr.toString(16)}`);
        this.table.set(slot, fn);
        let rc = this.exports.jit_install_region(
            entryPaddr, slot, priv, fs ? 1 : 0, expectedGen);
        if (rc === -2) {
            // No free physical-map slot within the probe bound: start a new
            // epoch and install into the empty map.
            this.stats.installRejects++;
            this.flushEpoch();
            prior = null;
            slot = this._allocSlot();
            if (slot < 0) return 0;
            this.table.set(slot, fn);
            rc = this.exports.jit_install_region(
                entryPaddr, slot, priv, fs ? 1 : 0, expectedGen);
        }
        if (rc !== 0) {
            this.stats.installRejects++;
            return 0;
        }

        this.stats.installs++;
        this.debug(`install #${this.stats.installs} paddr=0x${entryPaddr.toString(16)} off=0x${entryOff.toString(16)} insns=${compiled.insnCount} slot=${slot}`);
        this.instances.push(instance);
        if (!prior) {
            this.installed.set(key, {
                gen: expectedGen,
                entries: new Set([entryOff]),
                tableIdx: slot,
                instance,
            });
        } else {
            prior.entries.add(entryOff);
            prior.tableIdx = slot;
            prior.instance = instance;
        }
        this.stats.liveRegions = this.instances.length;

        if (this.instances.length > this.maxRegions) {
            this.flushEpoch();
        }
        return 1;
    }

    flushEpoch() {
        this.exports.jit_epoch_flush?.();
        this.installed.clear();
        this.failed.clear();
        this.instances.length = 0;
        this.liveRegions = 0;
        // Bookkeeping keyed by (page, generation) only grows; drop it with
        // the epoch.
        this.failedEntries.clear();
        this.nextSlot = this.tableBase;
        this.epochFlushes++;
        this.stats.epochFlushes++;
        this.stats.liveRegions = 0;
    }

    _noteInvalidation(pageBase) {
        const now = Date.now();
        let t = this.thrash.get(pageBase);
        if (!t) {
            if (this.thrash.size > 65536) this.thrash.clear();
            t = { count: 0, windowStart: now, until: 0, backoff: 1000 };
            this.thrash.set(pageBase, t);
        }
        if (now - t.windowStart > this.thrashWindowMs) {
            t.windowStart = now;
            t.count = 0;
        }
        if (++t.count > this.thrashLimit) {
            t.until = now + t.backoff;
            t.backoff = Math.min(t.backoff * 2, 64000);
            t.count = 0;
            t.windowStart = now;
            this.stats.thrashCooldowns = (this.stats.thrashCooldowns || 0) + 1;
        }
    }

    _coolingDown(pageBase) {
        const t = this.thrash.get(pageBase);
        return t !== undefined && t.until !== 0 && Date.now() < t.until;
    }

    poll() {
        if (this.port) {
            this._drainWorker();
            if (this.queue.length) this._sendBatch();
        } else if (this.queue.length) {
            this._installBatch();
        }
        if (this.cache) this.cache.flush();
    }

    // Start the compiler worker (async mode). Returns false if workers are
    // unavailable; the engine then compiles synchronously in poll().
    _startWorker() {
        try {
            const { port1, port2 } = new MessageChannel();
            this.worker = new Worker(path.join(__dirname, 'compiler-worker.js'), {
                workerData: { port: port2 },
                transferList: [port2],
            });
            this.worker.unref();
            this.port = port1;
            this.inflight = new Map();
            this.nextBatchId = 1;
            this.nextReqId = 1;
            return true;
        } catch (err) {
            this.debug(`compiler worker unavailable: ${err.message}`);
            return false;
        }
    }

    _pageGen(pageBase) {
        if (!this.pageGenBase) return null;
        const idx = Number((pageBase >> 12n) & 0xfffffn);
        return new DataView(this.memory.buffer).getUint32(this.pageGenBase + idx * 4, true);
    }

    // Compile every queued entry into one module and install the regions.
    // Queued requests whose page is still at the requested generation, with
    // the page bytes (read once per page).
    _prepare(items) {
        const pages = new Map();
        const out = [];
        for (const it of items) {
            // The page changed since the request: the install would be
            // rejected anyway.
            const gen = this._pageGen(it.pageBase);
            if (gen !== null && gen !== it.expectedGen) {
                this.queued.delete(it.entryKey);
                this.stats.installRejects++;
                continue;
            }
            const pk = it.pageBase.toString();
            let bytes = pages.get(pk);
            if (bytes === undefined) {
                bytes = this._readPage(it.pageBase);
                pages.set(pk, bytes);
            }
            if (!bytes) {
                this.queued.delete(it.entryKey);
                continue;
            }
            out.push({ it, bytes, pk });
        }
        return out;
    }

    // Synchronous batch: compile on the emulator thread.
    _installBatch() {
        const items = this.queue.splice(0, this.batchMax);
        const t0 = process.hrtime.bigint();
        const ready = [];
        for (const { it, bytes } of this._prepare(items)) {
            this.queued.delete(it.entryKey);
            let region;
            try {
                region = buildRegion(bytes, it.entryOff, { maxInsns: 512 });
            } catch (err) {
                this.failedEntries.add(it.entryKey);
                this.debug(`region build failed: ${err.message}`);
                continue;
            }
            if (region.totalInsns === 0) {
                this.failedEntries.add(it.entryKey);
                continue;
            }
            ready.push({ it, region, exportName: `r${ready.length}`, insns: region.totalInsns });
        }
        if (ready.length === 0) return;
        let moduleBytes;
        try {
            moduleBytes = buildModuleMany(ready.map((r) => r.region), {
                exportPrefix: 'r', inlineStores: !this.verifyStores,
                loadHelper: this.hasLoadHelper,
                chain: this.chain,
                tlbTag: this.tlbTag,
                coalesce: this.coalesce,
                tlbSize: this.tlbSize,
            });
        } catch (err) {
            for (const r of ready) this.failedEntries.add(r.it.entryKey);
            this.debug(`batch compile failed: ${err.message}`);
            return;
        }
        this.stats.compileNs += process.hrtime.bigint() - t0;
        this._instantiateAndInstall({ moduleBytes }, ready);
    }

    // Async batch: hand the pages to the compiler worker.
    _sendBatch() {
        const items = this.queue.splice(0, this.batchMax);
        const prepared = this._prepare(items);
        if (prepared.length === 0) return;
        const pageIndex = new Map();
        const pages = [];
        const msgItems = [];
        const byReq = new Map();
        for (const { it, bytes, pk } of prepared) {
            let pi = pageIndex.get(pk);
            if (pi === undefined) {
                pi = pages.length;
                pages.push(bytes);
                pageIndex.set(pk, pi);
            }
            const reqId = this.nextReqId++;
            byReq.set(reqId, it);
            msgItems.push({ reqId, page: pi, entryOff: it.entryOff });
        }
        const id = this.nextBatchId++;
        this.inflight.set(id, byReq);
        this.port.postMessage({
            type: 'batch', id, pages, items: msgItems,
            options: {
                inlineStores: !this.verifyStores, loadHelper: this.hasLoadHelper,
                chain: this.chain, tlbTag: this.tlbTag, coalesce: this.coalesce,
                tlbSize: this.tlbSize, maxInsns: 512,
            },
        });
        this.stats.batchesSent = (this.stats.batchesSent || 0) + 1;
    }

    // Install every finished batch the compiler worker has posted.
    _drainWorker() {
        let m;
        while ((m = receiveMessageOnPort(this.port)) !== undefined) {
            const msg = m.message;
            const byReq = this.inflight.get(msg.id);
            if (!byReq) continue; // from before an epoch flush
            this.inflight.delete(msg.id);
            for (const it of byReq.values()) this.queued.delete(it.entryKey);
            for (const reqId of msg.failed) {
                const it = byReq.get(reqId);
                if (it) this.failedEntries.add(it.entryKey);
            }
            if (msg.error) this.debug(`worker batch failed: ${msg.error}`);
            this.stats.workerCodegenNs += BigInt(msg.codegenNs || 0);
            this.stats.workerCompileNs += BigInt(msg.compileNs || 0);
            if (!msg.module || msg.regions.length === 0) continue;
            const ready = [];
            for (const r of msg.regions) {
                const it = byReq.get(r.reqId);
                if (it) ready.push({ it, exportName: r.exportName, insns: r.insns });
            }
            this._instantiateAndInstall({ module: msg.module }, ready);
        }
    }

    _instantiateAndInstall(compiled, ready) {
        if (ready.length === 0) return;
        const t1 = process.hrtime.bigint();
        let instance;
        try {
            instance = this._instantiate(compiled, ready[0].it.statePtr);
        } catch (err) {
            for (const r of ready) this.failedEntries.add(r.it.entryKey);
            this.debug(`batch instantiate failed: ${err.message}`);
            return;
        }
        this.stats.instantiateNs += process.hrtime.bigint() - t1;
        this.stats.batches = (this.stats.batches || 0) + 1;
        this.instances.push(instance);

        for (const { it, exportName, insns } of ready) {
            this.stats.compiledRegions++;
            this.stats.compiledInsns += insns;
            let fn = instance.exports[exportName];
            if (this.verifier) fn = this.verifier.wrap(fn, `paddr=0x${it.entryPaddr.toString(16)}`);
            if (this.liveRegions >= this.maxRegions) {
                // Keep the physical map at most half full. The flush drops
                // the instance list, so re-add this batch's instance.
                this.flushEpoch();
                this.instances.push(instance);
            }
            let slot = this._allocSlot();
            if (slot < 0) return;
            this.table.set(slot, fn);
            let rc = this.exports.jit_install_region(
                it.entryPaddr, slot, it.priv, it.fs ? 1 : 0, it.expectedGen);
            if (rc === -2) {
                // No free slot within the probe bound: new epoch, retry once.
                this.stats.installRejects++;
                this.flushEpoch();
                this.instances.push(instance);
                slot = this._allocSlot();
                if (slot < 0) return;
                this.table.set(slot, fn);
                rc = this.exports.jit_install_region(
                    it.entryPaddr, slot, it.priv, it.fs ? 1 : 0, it.expectedGen);
            }
            if (rc !== 0) {
                this.stats.installRejects++;
                continue;
            }
            this.liveRegions++;
            this.stats.installs++;
            let prior = this.installed.get(it.key);
            if (!prior || prior.gen !== it.expectedGen) {
                prior = { gen: it.expectedGen, entries: new Set(), tableIdx: slot, instance };
                this.installed.set(it.key, prior);
            }
            prior.entries.add(it.entryOff);
        }
        this.stats.liveRegions = this.liveRegions;
    }
}

module.exports = { RegionJitEngine, PAGE_SIZE, PAGE_MASK };

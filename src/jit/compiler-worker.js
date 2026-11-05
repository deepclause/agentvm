'use strict';

// Region compiler worker (plan §4.6).
//
// Receives batches of { page bytes, entry offset } from the emulator thread,
// builds one wasm module per batch, and compiles it here. V8 compiles wasm
// functions lazily on first call, which would otherwise happen on the
// emulator thread in the middle of guest execution, so the worker also calls
// every region once against a dummy environment (the generation check at
// region entry fails and the function returns immediately). The compiled
// code lives in the shared native module, so the emulator thread receives a
// module whose functions are already compiled and only has to instantiate it.

const { parentPort, workerData } = require('node:worker_threads');
const { buildRegion } = require('./region');
const { buildModuleMany } = require('./emitter');

const port = workerData && workerData.port ? workerData.port : parentPort;

function dummyEnv() {
    // Page generations read as 0, and the warm-up call passes expected
    // generation 1, so each region returns at its entry check.
    const memory = new WebAssembly.Memory({ initial: 1 });
    const g = (v) => new WebAssembly.Global({ value: 'i32' }, v);
    return {
        memory,
        regs_base: g(0x100), tlb_read_base: g(0x400), tlb_write_base: g(0x400),
        cycles_ptr: g(0x80), page_gen_base: g(0x1000), pc_ptr: g(0x88), load_val_ptr: g(0x90),
        tlb_tag_ptr: g(0x98),
        jit_set_pc() {}, jit_sub_cycles() {}, jit_step() { return 0; },
        jit_store() { return 3; }, jit_load() { return 1; },
        // Never reached during warm-up (the entry generation check returns).
        jit_chain() { return 0; },
    };
}

function compileBatch(msg) {
    const t0 = process.hrtime.bigint();
    const regions = [];
    const built = [];
    const failed = [];
    for (const item of msg.items) {
        // Structured clone delivers Buffers as plain Uint8Arrays.
        const raw = msg.pages[item.page];
        const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        try {
            const region = buildRegion(bytes, item.entryOff, { maxInsns: msg.options.maxInsns || 512 });
            if (region.totalInsns === 0) {
                failed.push(item.reqId);
                continue;
            }
            built.push({ reqId: item.reqId, exportName: `r${regions.length}`, insns: region.totalInsns });
            regions.push(region);
        } catch {
            failed.push(item.reqId);
        }
    }
    let module = null;
    let error = null;
    const t1 = process.hrtime.bigint();
    if (regions.length) {
        try {
            const moduleBytes = buildModuleMany(regions, {
                exportPrefix: 'r',
                inlineStores: msg.options.inlineStores,
                loadHelper: msg.options.loadHelper,
                chain: msg.options.chain,
                tlbTag: msg.options.tlbTag,
                coalesce: msg.options.coalesce,
                tlbSize: msg.options.tlbSize,
            });
            module = new WebAssembly.Module(moduleBytes);
            const inst = new WebAssembly.Instance(module, { env: dummyEnv() });
            for (const b of built) inst.exports[b.exportName](0, 0n, 0, 1);
        } catch (err) {
            error = err.message;
            module = null;
        }
    }
    const t2 = process.hrtime.bigint();
    return {
        id: msg.id,
        module,
        regions: module ? built : [],
        failed: module ? failed : failed.concat(built.map((b) => b.reqId)),
        error,
        codegenNs: t1 - t0,
        compileNs: t2 - t1,
    };
}

port.on('message', (msg) => {
    if (msg && msg.type === 'batch') port.postMessage(compileBatch(msg));
});

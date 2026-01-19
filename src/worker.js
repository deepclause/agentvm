const { parentPort, workerData } = require('node:worker_threads');
const { WASI } = require('node:wasi');
const fs = require('node:fs');

const { wasmPath, sharedInputBuffer, mounts } = workerData;
const inputInt32 = new Int32Array(sharedInputBuffer);
const INPUT_FLAG_INDEX = 0;
const INPUT_SIZE_INDEX = 1;
const INPUT_DATA_OFFSET = 8;

let localBuffer = new Uint8Array(0);

// Helper to read IOVectors from WASM memory
function readIOVs(view, iovs_ptr, iovs_len) {
    const buffers = [];
    for (let i = 0; i < iovs_len; i++) {
        const ptr = view.getUint32(iovs_ptr + i * 8, true);
        const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
        buffers.push(new Uint8Array(view.buffer, ptr, len));
    }
    return buffers;
}

// Helper to write data to IOVectors
function writeIOVs(view, iovs_ptr, iovs_len, data) {
    let bytesWritten = 0;
    let dataOffset = 0;
    for (let i = 0; i < iovs_len && dataOffset < data.length; i++) {
        const ptr = view.getUint32(iovs_ptr + i * 8, true);
        const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
        const chunkLen = Math.min(len, data.length - dataOffset);
        const dest = new Uint8Array(view.buffer, ptr, chunkLen);
        dest.set(data.subarray(dataOffset, dataOffset + chunkLen));
        bytesWritten += chunkLen;
        dataOffset += chunkLen;
    }
    return bytesWritten;
}

let instance = null;

async function start() {
    const wasmBuffer = fs.readFileSync(wasmPath);
    
    const wasi = new WASI({
        version: 'preview1',
        args: ['agentvm'],
        env: { 'TERM': 'xterm-256color' },
        preopens: mounts || {} 
    });

    const wasiImport = wasi.wasiImport;

    const originalFdWrite = wasiImport.fd_write;
    wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        try {
            if (fd === 1 || fd === 2) {
                if (!instance) return 0; 
                const view = new DataView(instance.exports.memory.buffer);
                const buffers = readIOVs(view, iovs_ptr, iovs_len);
                
                const totalLen = buffers.reduce((acc, b) => acc + b.byteLength, 0);
                const result = new Uint8Array(totalLen);
                let offset = 0;
                for (const b of buffers) {
                    result.set(b, offset);
                    offset += b.byteLength;
                }

                parentPort.postMessage({
                    type: fd === 1 ? 'stdout' : 'stderr',
                    data: result
                });

                view.setUint32(nwritten_ptr, totalLen, true);
                return 0; // WASI_ESUCCESS
            }
        } catch (err) {
            // parentPort.postMessage({ type: 'debug', msg: `Error in fd_write: ${err.message}` });
        }
        return originalFdWrite(fd, iovs_ptr, iovs_len, nwritten_ptr);
    };

    const originalFdRead = wasiImport.fd_read;
    wasiImport.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
        if (fd === 0) {
            if (!instance) return 0;
            
            if (localBuffer.length === 0) {
                 Atomics.wait(inputInt32, INPUT_FLAG_INDEX, 0);
                 
                 const size = inputInt32[INPUT_SIZE_INDEX];
                 if (size > 0) {
                     const sharedData = new Uint8Array(sharedInputBuffer, INPUT_DATA_OFFSET, size);
                     localBuffer = sharedData.slice(0);
                 }
                 
                 inputInt32[INPUT_SIZE_INDEX] = 0;
                 Atomics.store(inputInt32, INPUT_FLAG_INDEX, 0);
                 Atomics.notify(inputInt32, INPUT_FLAG_INDEX);
            }

            if (localBuffer.length === 0) return 0; 
            
            const view = new DataView(instance.exports.memory.buffer);
            const bytesWritten = writeIOVs(view, iovs_ptr, iovs_len, localBuffer);
            
            view.setUint32(nread_ptr, bytesWritten, true);
            localBuffer = localBuffer.subarray(bytesWritten);
            
            return 0; // Success
        }
        return originalFdRead(fd, iovs_ptr, iovs_len, nread_ptr);
    };

    const originalPollOneoff = wasiImport.poll_oneoff;
    wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        if (!instance) return originalPollOneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr);
        const view = new DataView(instance.exports.memory.buffer);
        
        let hasStdin = false;
        let minTimeout = Infinity;

        for (let i = 0; i < nsubscriptions; i++) {
             const base = in_ptr + i * 48;
             const type = view.getUint8(base + 8);
             if (type === 1) { // FD_READ
                 const fd = view.getUint32(base + 16, true);
                 if (fd === 0) hasStdin = true;
             } else if (type === 0) { // CLOCK
                 const timeout = view.getBigUint64(base + 24, true);
                 const flags = view.getUint16(base + 40, true);
                 
                 let t = Number(timeout) / 1000000; // to ms
                 if ((flags & 1) === 1) {
                     t = 0; 
                 }
                 if (t < minTimeout) minTimeout = t;
             }
        }
        
        if (hasStdin) {
            const hasData = localBuffer.length > 0 || Atomics.load(inputInt32, INPUT_FLAG_INDEX) !== 0;
            
            if (hasData) {
                 let eventsWritten = 0;
                 for(let i=0; i<nsubscriptions; i++) {
                    const base = in_ptr + i * 48;
                    const userdata = view.getBigUint64(base, true);
                    const type = view.getUint8(base + 8);
                    if (type === 1) {
                        const fd = view.getUint32(base + 16, true);
                        if (fd === 0) {
                            const eventBase = out_ptr + eventsWritten * 32;
                            view.setBigUint64(eventBase, userdata, true);
                            view.setUint16(eventBase + 8, 0, true);
                            view.setUint8(eventBase + 10, 1, true); // FD_READ
                            view.setBigUint64(eventBase + 16, BigInt(localBuffer.length || 1), true);
                            eventsWritten++;
                        }
                    }
                 }
                 if (eventsWritten > 0) {
                     view.setUint32(nevents_ptr, eventsWritten, true);
                     return 0;
                 }
            }
            
            if (minTimeout <= 0) {
                return originalPollOneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr);
            }
            
            const waitTime = Math.max(0, Math.ceil(minTimeout));
            const res = Atomics.wait(inputInt32, INPUT_FLAG_INDEX, 0, waitTime);
            
            if (res !== 'timed-out') {
                 let eventsWritten = 0;
                 for(let i=0; i<nsubscriptions; i++) {
                    const base = in_ptr + i * 48;
                    const userdata = view.getBigUint64(base, true);
                    const type = view.getUint8(base + 8);
                    if (type === 1) {
                        const fd = view.getUint32(base + 16, true);
                        if (fd === 0) {
                            const eventBase = out_ptr + eventsWritten * 32;
                            view.setBigUint64(eventBase, userdata, true);
                            view.setUint16(eventBase + 8, 0, true);
                            view.setUint8(eventBase + 10, 1, true); 
                            view.setBigUint64(eventBase + 16, BigInt(1), true);
                            eventsWritten++;
                        }
                    }
                 }
                 view.setUint32(nevents_ptr, eventsWritten, true);
                 return 0;
            }
            
             return originalPollOneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr);
        }
        
        return originalPollOneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr);
    };

    const { instance: inst } = await WebAssembly.instantiate(wasmBuffer, {
        wasi_snapshot_preview1: wasiImport
    });
    
    instance = inst;

    parentPort.postMessage({ type: 'ready' });

    try {
        wasi.start(instance);
        parentPort.postMessage({ type: 'exit', code: 0 });
    } catch (e) {
        parentPort.postMessage({ type: 'exit', error: e.message });
    }
}

start();

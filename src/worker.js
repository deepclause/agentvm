const { parentPort, workerData, receiveMessageOnPort } = require('node:worker_threads');
const { WASI } = require('node:wasi');
const fs = require('node:fs');
const { NetworkStack } = require('./network');

const { wasmPath, sharedInputBuffer, mounts, network, mac, udpPort } = workerData;
const inputInt32 = new Int32Array(sharedInputBuffer);
const INPUT_FLAG_INDEX = 0;
const INPUT_SIZE_INDEX = 1;
const INPUT_DATA_OFFSET = 8;

let localBuffer = new Uint8Array(0);

// Buffer for sock_recv to handle partial reads
let sockRecvBuffer = Buffer.alloc(0);

// Initialize Network Stack with UDP port for main-thread communication
const netStack = new NetworkStack({ udpPort });
const NET_FD = 3; // Standard for LISTEN_FDS=1 (listening socket)
const NET_CONN_FD = 4; // Connected socket for actual I/O
let netConnectionAccepted = false;

netStack.on('error', (err) => {
    parentPort.postMessage({ type: 'error', msg: `[NetStack] ${err.message}` });
});

netStack.on('debug', (msg) => {
    parentPort.postMessage({ type: 'debug', msg: `[NetStack] ${msg}` });
});

netStack.on('network-activity', () => {
    // We should wake up poll_oneoff if it's waiting?
    // Not easily possible unless we use SharedArrayBuffer for signaling or
    // just rely on poll timeout loop.
});

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
    
    // Build WASI args based on options
    // The emulator supports -net socket for networking via WASI sockets
    const wasiArgs = ['agentvm'];
    if (network) {
        wasiArgs.push('-net', 'socket');
        if (mac) {
            wasiArgs.push('-mac', mac);
        }
    }
    
    // parentPort.postMessage({ type: 'debug', msg: `WASI args: ${wasiArgs.join(' ')}` });
    
    const wasi = new WASI({
        version: 'preview1',
        args: wasiArgs,
        env: { 'TERM': 'xterm-256color', 'LISTEN_FDS': '1' },
        preopens: mounts || {} 
    });

    const wasiImport = wasi.wasiImport;

    const originalFdWrite = wasiImport.fd_write;
    wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        try {
            if (fd === NET_FD) {
                if (!instance) return 0;
                const view = new DataView(instance.exports.memory.buffer);
                const buffers = readIOVs(view, iovs_ptr, iovs_len);
                
                let totalLen = 0;
                for(const buf of buffers) {
                    // // parentPort.postMessage({ type: 'debug', msg: `Writing ${buf.length} bytes to network` });
                    netStack.writeToNetwork(buf);
                    totalLen += buf.length;
                }
                
                view.setUint32(nwritten_ptr, totalLen, true);
                return 0; // Success
            }
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
            // // parentPort.postMessage({ type: 'debug', msg: `Error in fd_write: ${err.message}` });
        }
        return originalFdWrite(fd, iovs_ptr, iovs_len, nwritten_ptr);
    };

    const originalFdRead = wasiImport.fd_read;
    wasiImport.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
        if (fd === NET_FD) {
            // parentPort.postMessage({ type: 'debug', msg: `fd_read(${fd}) - network read attempt` });
            if (!instance) return 0;
            const view = new DataView(instance.exports.memory.buffer);
            
            const data = netStack.readFromNetwork(4096);
            if (!data || data.length === 0) {
                view.setUint32(nread_ptr, 0, true);
                return 0;
            }
            
            const bytesWritten = writeIOVs(view, iovs_ptr, iovs_len, data);
            view.setUint32(nread_ptr, bytesWritten, true);
            return 0;
        }
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

    const originalFdFdstatGet = wasiImport.fd_fdstat_get;
    wasiImport.fd_fdstat_get = (fd, bufPtr) => {
        if (fd === NET_FD || fd === NET_FD + 1) { // fd 3 (listen) or fd 4 (connection)
            // // parentPort.postMessage({ type: 'debug', msg: `fd_fdstat_get(${fd})` });
            if (!instance) return 0;
            const view = new DataView(instance.exports.memory.buffer);
            
            // struct fdstat {
            //   fs_filetype: u8,
            //   fs_flags: u16,
            //   fs_rights_base: u64,
            //   fs_rights_inheriting: u64
            // }
            
            view.setUint8(bufPtr, 6); // FILETYPE_SOCKET_STREAM (6)
            view.setUint16(bufPtr + 2, 0, true); // flags
            
            // Rights: Read(1) | Write(2) | Poll(32?) | ...
            // Let's give lots of rights.
            view.setBigUint64(bufPtr + 8, BigInt("0xFFFFFFFFFFFFFFFF"), true);
            view.setBigUint64(bufPtr + 16, BigInt("0xFFFFFFFFFFFFFFFF"), true);
            
            return 0; // Success
        }
        return originalFdFdstatGet(fd, bufPtr);
    };

    const originalPollOneoff = wasiImport.poll_oneoff;
    wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        if (!instance) return originalPollOneoff(in_ptr, out_ptr, nsubscriptions, nevents_ptr);
        const view = new DataView(instance.exports.memory.buffer);
        
        let hasStdin = false;
        let hasNetRead = false;
        let hasNetWrite = false;
        let hasNetListen = false;
        let minTimeout = Infinity;

        // 1. Scan subscriptions
        for (let i = 0; i < nsubscriptions; i++) {
             const base = in_ptr + i * 48;
             const type = view.getUint8(base + 8);
             if (type === 1) { // FD_READ
                 const fd = view.getUint32(base + 16, true);
                 if (fd === 0) hasStdin = true;
                 if (fd === NET_FD) {
                     hasNetListen = true;
                     // // parentPort.postMessage({ type: 'debug', msg: `poll_oneoff FD_READ for listen fd ${NET_FD}` });
                 }
                 if (fd === NET_FD + 1) {
                     hasNetRead = true;
                     // // parentPort.postMessage({ type: 'debug', msg: `poll_oneoff FD_READ for conn fd ${NET_FD + 1}, pending=${netStack.hasPendingData()}` });
                 }
             } else if (type === 2) { // FD_WRITE
                 const fd = view.getUint32(base + 16, true);
                 if (fd === NET_FD + 1) {
                     hasNetWrite = true;
                     // // parentPort.postMessage({ type: 'debug', msg: `poll_oneoff FD_WRITE for NET_FD` });
                 }
             } else if (type === 0) { // CLOCK
                 const timeout = view.getBigUint64(base + 24, true);
                 const flags = view.getUint16(base + 40, true);
                 
                 let t = Number(timeout) / 1000000; // to ms
                 if ((flags & 1) === 1) { // ABSOLUTE (not supported properly here, assume relative 0?)
                     // Actually WASI clock time is complicated. 
                     // Usually relative (flags=0).
                     // If absolute, we need current time.
                     // For now assume relative or 0.
                     t = 0; 
                 }
                 if (t < minTimeout) minTimeout = t;
             }
        }
        
        // 2. Check Immediate Status
        const netReadable = netStack.hasPendingData();
        const netWritable = true; // Always writable
        const stdinReadable = localBuffer.length > 0 || Atomics.load(inputInt32, INPUT_FLAG_INDEX) !== 0;
        
        let ready = false;
        if (hasStdin && stdinReadable) ready = true;
        if (hasNetRead && netReadable) ready = true;
        if (hasNetWrite && netWritable) ready = true;
        
        // 3. Wait if needed
        if (!ready && minTimeout !== 0) {
            // We can only wait on Stdin safely via Atomics.
            // If we are waiting for Net Read, and it's not ready, we depend on external event.
            // But we can't wait on external event easily here.
            // However, Net Write is always ready, so if hasNetWrite is true, we wouldn't be here.
            
            // So we are here if:
            // - Asking for Stdin (empty) AND/OR Net Read (empty)
            // - AND NOT asking for Net Write
            
            // If we have a timeout, we wait.
            let waitTime = 0;
            if (minTimeout !== Infinity) {
                waitTime = Math.max(0, Math.ceil(minTimeout));
            } else {
                waitTime = -1; // Infinite
            }
            
            // If we are waiting for Stdin, we can use Atomics.wait
            if (hasStdin || hasNetRead || waitTime > 0) {
                 // Problem: Atomics.wait blocks the event loop completely.
                 // UDP responses come via MessagePort from main thread.
                 // Solution: Use short waits and poll for UDP messages via receiveMessageOnPort.
                 
                 const t = (waitTime === -1) ? 30000 : waitTime; // Max 30s for "infinite"
                 const chunkSize = 5; // 5ms chunks - good balance between responsiveness and CPU
                 let remaining = t;
                 
                 while (remaining > 0) {
                     const waitChunk = Math.min(chunkSize, remaining);
                     Atomics.wait(inputInt32, INPUT_FLAG_INDEX, 0, waitChunk);
                     remaining -= waitChunk;
                     
                     // Poll for UDP responses from main thread (synchronous)
                     netStack.pollUdpResponses();
                     
                     // Check if stdin became available
                     if (Atomics.load(inputInt32, INPUT_FLAG_INDEX) !== 0) break;
                     
                     // Check if network data became available (from UDP responses)
                     if (hasNetRead && netStack.hasPendingData()) break;
                 }
            }
        }
        
        // 4. Populate Events
        let eventsWritten = 0;
        
        // Refresh status
        const postStdinReadable = localBuffer.length > 0 || Atomics.load(inputInt32, INPUT_FLAG_INDEX) !== 0;
        const postNetReadable = netStack.hasPendingData();
        
        for(let i=0; i<nsubscriptions; i++) {
             const base = in_ptr + i * 48;
             const userdata = view.getBigUint64(base, true);
             const type = view.getUint8(base + 8);
             
             let evType = 0;
             let nbytes = 0;
             let triggered = false;
             
             if (type === 1) { // READ
                 const fd = view.getUint32(base + 16, true);
                 if (fd === 0 && postStdinReadable) {
                     triggered = true;
                     evType = 1;
                     nbytes = localBuffer.length || 1;
                 } else if (fd === NET_FD && netConnectionAccepted) {
                     // Listen socket - always readable if we haven't accepted yet (to trigger sock_accept)
                     // But we've already accepted, so not readable
                 } else if (fd === NET_FD + 1 && postNetReadable) {
                     // Connected socket - readable if there's data
                     triggered = true;
                     evType = 1;
                     nbytes = netStack.txBuffer.length;
                     // // parentPort.postMessage({ type: 'debug', msg: `poll: conn fd readable, ${nbytes} bytes` });
                 }
             } else if (type === 2) { // WRITE
                 const fd = view.getUint32(base + 16, true);
                 if (fd === NET_FD + 1) {
                     // Connected socket - always writable
                     triggered = true;
                     evType = 2;
                     nbytes = 4096;
                 }
             } else if (type === 0) { // CLOCK
                 // Assume triggered if we passed the wait block
                 triggered = true;
                 evType = 0;
             }
             
             if (triggered) {
                 const eventBase = out_ptr + eventsWritten * 32;
                 view.setBigUint64(eventBase, userdata, true);
                 view.setUint16(eventBase + 8, 0, true); // errno
                 view.setUint8(eventBase + 10, evType, true);
                 view.setBigUint64(eventBase + 16, BigInt(nbytes), true);
                 eventsWritten++;
             }
        }
        
        view.setUint32(nevents_ptr, eventsWritten, true);
        return 0; // Success
    };



    const { instance: inst } = await WebAssembly.instantiate(wasmBuffer, {
        wasi_snapshot_preview1: {
            ...wasiImport,
            // WASI Socket Extensions (for network support)
            sock_accept: (fd, flags, result_fd_ptr) => {
                if (fd !== NET_FD) {
                    // parentPort.postMessage({ type: 'debug', msg: `sock_accept(${fd}) - wrong fd` });
                    return 8; // WASI_ERRNO_BADF
                }
                
                if (!instance) return 0;
                const view = new DataView(instance.exports.memory.buffer);
                
                if (!netConnectionAccepted) {
                    netConnectionAccepted = true;
                    // parentPort.postMessage({ type: 'debug', msg: `sock_accept(${fd}) -> returning fd ${NET_CONN_FD}` });
                    view.setUint32(result_fd_ptr, NET_CONN_FD, true);
                    return 0; // Success
                }
                
                // Only one connection allowed - block/return EAGAIN
                // parentPort.postMessage({ type: 'debug', msg: `sock_accept(${fd}) -> EAGAIN (already have connection)` });
                return 6; // WASI_ERRNO_AGAIN - would block
            },
            sock_recv: (fd, ri_data_ptr, ri_data_len, ri_flags, ro_datalen_ptr, ro_flags_ptr) => {
                // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) called, buffered=${sockRecvBuffer.length}, pending=${netStack.hasPendingData()}` });
                
                if (fd !== NET_CONN_FD) {
                    // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) - wrong fd` });
                    return 8; // WASI_ERRNO_BADF
                }
                
                if (!instance) return 0;
                const view = new DataView(instance.exports.memory.buffer);
                
                // First check if we have buffered data from a previous partial read
                if (sockRecvBuffer.length === 0) {
                    const data = netStack.readFromNetwork(4096);
                    if (!data || data.length === 0) {
                        view.setUint32(ro_datalen_ptr, 0, true);
                        view.setUint16(ro_flags_ptr, 0, true);
                        // Return EAGAIN to indicate no data available
                        return 6; // WASI_ERRNO_AGAIN
                    }
                    sockRecvBuffer = data;
                }
                
                // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) have ${sockRecvBuffer.length} bytes to deliver` });
                
                // Write data to iovec buffers
                const bytesWritten = writeIOVs(view, ri_data_ptr, ri_data_len, sockRecvBuffer);
                
                // Keep any unwritten data for the next call
                sockRecvBuffer = sockRecvBuffer.subarray(bytesWritten);
                
                // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) wrote ${bytesWritten} bytes, remaining=${sockRecvBuffer.length}` });
                view.setUint32(ro_datalen_ptr, bytesWritten, true);
                view.setUint16(ro_flags_ptr, 0, true);
                
                return 0; // Success
            },
            sock_send: (fd, si_data_ptr, si_data_len, si_flags, so_datalen_ptr) => {
                if (fd !== NET_CONN_FD) {
                    return 8; // WASI_ERRNO_BADF
                }
                
                if (!instance) return 0;
                const view = new DataView(instance.exports.memory.buffer);
                
                // Read from iovec buffers
                const buffers = readIOVs(view, si_data_ptr, si_data_len);
                
                let totalLen = 0;
                for (const buf of buffers) {
                    netStack.writeToNetwork(Buffer.from(buf));
                    totalLen += buf.length;
                }
                
                view.setUint32(so_datalen_ptr, totalLen, true);
                return 0; // Success
            },
            sock_shutdown: (fd, how) => {
                // parentPort.postMessage({ type: 'debug', msg: `sock_shutdown(${fd}, ${how})` });
                return 0; // Success
            }
        }
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

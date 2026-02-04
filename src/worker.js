const { parentPort, workerData, receiveMessageOnPort } = require('node:worker_threads');
const { WASI } = require('node:wasi');
const fs = require('node:fs');
const { NetworkStack } = require('./network');
const { RingBufferReader, IO_READY_INDEX, STDIN_FLAG_INDEX, STDIN_SIZE_INDEX, STDIN_DATA_OFFSET, NET_RING_OFFSET } = require('./ringbuffer');

const { wasmPath, sharedBuffer, mounts, network, mac, netPort } = workerData;

// Initialize ring buffer reader for shared memory IPC (main → worker data)
const ringReader = new RingBufferReader(sharedBuffer);

let localBuffer = new Uint8Array(0);

// Buffer for sock_recv to handle partial reads
let sockRecvBuffer = Buffer.alloc(0);

// Initialize Network Stack with:
// - ringReader for incoming data (main → worker, via SharedArrayBuffer)
// - netPort for outgoing control messages (worker → main, via MessagePort)
const netStack = new NetworkStack({ ringReader, netPort });
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
    // Network activity is signaled via IO_READY_INDEX in the shared buffer
    // which wakes up ringReader.waitForIO() in poll_oneoff
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
    
    // Store preopens for our custom path_open implementation
    const preopenPaths = mounts || {};
    // Map wasi fd to host path (fd 3 onwards)
    const fdToHostPath = new Map();
    let preopen_fd = 3;
    for (const [wasiPath, hostPath] of Object.entries(preopenPaths)) {
        fdToHostPath.set(preopen_fd, { wasiPath, hostPath: require('path').resolve(hostPath) });
        preopen_fd++;
    }
    
    const wasi = new WASI({
        version: 'preview1',
        args: wasiArgs,
        env: { 'TERM': 'xterm-256color', 'LISTEN_FDS': '1' },
        preopens: preopenPaths 
    });

    const wasiImport = wasi.wasiImport;
    
    // Track next available fd for our fake duplicates and custom file handles
    let nextFakeFd = 100; // Start high to avoid conflicts
    const fakeFdMap = new Map(); // fake fd -> original fd (for directory duplicates)
    const customFdHandles = new Map(); // fd -> {type: 'file', handle: fs.FileHandle, hostPath: string}
    
    // Fix for path_open: Node.js WASI has multiple bugs with preopened directories
    // We implement our own file opening for preopened directory contents
    const origPathOpen = wasiImport.path_open;
    wasiImport.path_open = (fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, opened_fd_ptr) => {
        // Get the path string
        let pathStr = '';
        if (instance) {
            const mem = new Uint8Array(instance.exports.memory.buffer);
            const pathBytes = mem.slice(path_ptr, path_ptr + path_len);
            pathStr = new TextDecoder().decode(pathBytes);
        }
        
        // Resolve fake fd to real fd for the base directory
        let actualFd = fakeFdMap.has(fd) ? fakeFdMap.get(fd) : fd;
        
        // Check if this is a preopened directory OR one of our custom directory handles
        let preopenInfo = fdToHostPath.get(actualFd);
        
        // Also check if fd is one of our custom directory handles
        if (!preopenInfo && customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (handle.type === 'directory') {
                preopenInfo = { hostPath: handle.hostPath, wasiPath: handle.wasiPath };
            }
        }
        
        // Fix: Node.js WASI doesn't handle path_open(fd, ".") properly for preopens
        if (pathStr === '.' && (oflags & 0x2) !== 0 && preopenInfo) {
            const fakeFd = nextFakeFd++;
            // For custom directory handles, map to a new custom handle instead of fakeFdMap
            if (customFdHandles.has(fd)) {
                customFdHandles.set(fakeFd, {
                    type: 'directory',
                    hostPath: preopenInfo.hostPath,
                    wasiPath: preopenInfo.wasiPath
                });
            } else {
                fakeFdMap.set(fakeFd, actualFd);
            }
            if (instance) {
                const view = new DataView(instance.exports.memory.buffer);
                view.setUint32(opened_fd_ptr, fakeFd, true);
            }
            if (process.env.DEBUG_WASI_PATH === '1') {
                parentPort.postMessage({ 
                    type: 'debug', 
                    msg: `WASI path_open(fd=${fd}, path=".") => 0 (faked as fd ${fakeFd})` 
                });
            }
            return 0;
        }
        
        // For files OR subdirectories inside preopened directories, implement our own handling
        // because Node.js WASI has bugs with 64-bit rights validation and subdirectory access
        if (preopenInfo && pathStr !== '.') {
            const hostFilePath = require('path').join(preopenInfo.hostPath, pathStr);
            
            // WASI oflags
            const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
            
            // Handle opening subdirectories
            if (oflags & O_DIRECTORY) {
                try {
                    const stat = fs.statSync(hostFilePath);
                    if (!stat.isDirectory()) {
                        return 54; // WASI_ERRNO_NOTDIR
                    }
                    
                    // Create a fake fd that maps to this subdirectory path
                    const newFd = nextFakeFd++;
                    // Store subdirectory info so future path_open calls relative to this fd work
                    customFdHandles.set(newFd, {
                        type: 'directory',
                        hostPath: hostFilePath,
                        wasiPath: require('path').join(preopenInfo.wasiPath, pathStr)
                    });
                    
                    if (instance) {
                        const view = new DataView(instance.exports.memory.buffer);
                        view.setUint32(opened_fd_ptr, newFd, true);
                    }
                    
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({
                            type: 'debug',
                            msg: `WASI path_open CUSTOM DIR: fd=${fd}, path="${pathStr}" => 0 (custom fd ${newFd})`
                        });
                    }
                    return 0;
                } catch (err) {
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({
                            type: 'debug',
                            msg: `WASI path_open CUSTOM DIR FAIL: fd=${fd}, path="${pathStr}" => ${err.message}`
                        });
                    }
                    if (err.code === 'ENOENT') return 44; // WASI_ERRNO_NOENT
                    if (err.code === 'EACCES') return 2;  // WASI_ERRNO_ACCES
                    if (err.code === 'ENOTDIR') return 54; // WASI_ERRNO_NOTDIR
                    return 28; // WASI_ERRNO_INVAL
                }
            }
            
            // This is trying to open a file (not a directory) inside a preopen
            // WASI fdflags
            const FDFLAG_APPEND = 1, FDFLAG_DSYNC = 2, FDFLAG_NONBLOCK = 4, FDFLAG_RSYNC = 8, FDFLAG_SYNC = 16;
            
            try {
                let fileExists = false;
                let stat = null;
                try {
                    stat = fs.statSync(hostFilePath);
                    fileExists = true;
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
                
                // Handle O_EXCL: fail if file exists
                if ((oflags & O_EXCL) && fileExists) {
                    return 20; // WASI_ERRNO_EXIST
                }
                
                // Handle no O_CREAT and file doesn't exist
                if (!(oflags & O_CREAT) && !fileExists) {
                    return 44; // WASI_ERRNO_NOENT
                }
                
                // Determine open flags
                let fsFlags = 'r'; // Default read-only
                
                if (oflags & O_CREAT) {
                    if (oflags & O_TRUNC) {
                        fsFlags = 'w+'; // Create/truncate, read/write
                    } else if (fileExists) {
                        fsFlags = 'r+'; // Existing file, read/write
                    } else {
                        fsFlags = 'w+'; // Create new, read/write
                    }
                } else if (oflags & O_TRUNC) {
                    fsFlags = 'r+'; // Truncate existing (we'll truncate separately)
                }
                
                if (fdflags & FDFLAG_APPEND) {
                    fsFlags = fileExists ? 'a+' : 'a+'; // Append mode
                }
                
                // Open the file synchronously
                const nodeFd = fs.openSync(hostFilePath, fsFlags);
                
                // Handle O_TRUNC separately to ensure truncation
                if ((oflags & O_TRUNC) && fileExists) {
                    fs.ftruncateSync(nodeFd, 0);
                }
                
                // Get stat if we didn't already
                if (!stat) {
                    stat = fs.fstatSync(nodeFd);
                }
                
                // Map to our custom fd space
                const newFd = nextFakeFd++;
                customFdHandles.set(newFd, { 
                    type: 'file', 
                    nodeFd, 
                    hostPath: hostFilePath,
                    stat
                });
                
                if (instance) {
                    const view = new DataView(instance.exports.memory.buffer);
                    view.setUint32(opened_fd_ptr, newFd, true);
                }
                
                if (process.env.DEBUG_WASI_PATH === '1') {
                    parentPort.postMessage({ 
                        type: 'debug', 
                        msg: `WASI path_open CUSTOM: fd=${fd}, path="${pathStr}" => 0 (custom fd ${newFd}, nodeFd=${nodeFd})` 
                    });
                }
                return 0; // Success
                
            } catch (err) {
                if (process.env.DEBUG_WASI_PATH === '1') {
                    parentPort.postMessage({ 
                        type: 'debug', 
                        msg: `WASI path_open CUSTOM FAIL: fd=${fd}, path="${pathStr}" => ${err.message}` 
                    });
                }
                // Map Node.js errors to WASI errors
                if (err.code === 'ENOENT') return 44; // WASI_ERRNO_NOENT
                if (err.code === 'EACCES') return 2;  // WASI_ERRNO_ACCES
                if (err.code === 'EISDIR') return 31; // WASI_ERRNO_ISDIR
                return 28; // WASI_ERRNO_INVAL
            }
        }
        
        // Fallback to original implementation for non-preopens
        const ALL_RIGHTS = 0x1FFFFFFF;
        let fixedBase = (actualFd >= 3) ? ALL_RIGHTS : fs_rights_base;
        let fixedInheriting = (actualFd >= 3) ? ALL_RIGHTS : fs_rights_inheriting;
        let fixedFdflags = fdflags;
        
        // Fix O_NONBLOCK on directories
        if ((oflags & 0x2) !== 0 && (fdflags & 0x4) !== 0) {
            fixedFdflags = fdflags & ~0x4;
        }
        
        if (process.env.DEBUG_WASI_PATH === '1') {
            parentPort.postMessage({ 
                type: 'debug', 
                msg: `WASI path_open NATIVE: fd=${actualFd}, dirflags=${dirflags}, path="${pathStr}", oflags=${oflags}` 
            });
        }
        
        const result = origPathOpen(actualFd, dirflags, path_ptr, path_len, oflags, fixedBase, fixedInheriting, fixedFdflags, opened_fd_ptr);
        
        if (process.env.DEBUG_WASI_PATH === '1') {
            let openedFd = -1;
            if (result === 0 && instance) {
                const view = new DataView(instance.exports.memory.buffer);
                openedFd = view.getUint32(opened_fd_ptr, true);
            }
            parentPort.postMessage({ 
                type: 'debug', 
                msg: `WASI path_open NATIVE RESULT: ${result}, opened_fd=${openedFd}` 
            });
        }
        
        return result;
    };
    
    // Custom fd_read for our file handles
    const origFdRead = wasiImport.fd_read;
    wasiImport.fd_read = (fd, iovs_ptr, iovs_len, nread_ptr) => {
        // Check if this is one of our custom file handles
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (!instance) return 8; // WASI_ERRNO_BADF
            
            const view = new DataView(instance.exports.memory.buffer);
            const mem = new Uint8Array(instance.exports.memory.buffer);
            
            let totalRead = 0;
            for (let i = 0; i < iovs_len; i++) {
                const buf_ptr = view.getUint32(iovs_ptr + i * 8, true);
                const buf_len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                
                try {
                    const buffer = Buffer.alloc(buf_len);
                    const bytesRead = fs.readSync(handle.nodeFd, buffer, 0, buf_len, null);
                    
                    // Copy to WASM memory
                    for (let j = 0; j < bytesRead; j++) {
                        mem[buf_ptr + j] = buffer[j];
                    }
                    totalRead += bytesRead;
                    
                    if (bytesRead < buf_len) break; // EOF or partial read
                } catch (err) {
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({ 
                            type: 'debug', 
                            msg: `WASI fd_read CUSTOM ERROR: fd=${fd}, err=${err.message}` 
                        });
                    }
                    return 29; // WASI_ERRNO_IO
                }
            }
            
            view.setUint32(nread_ptr, totalRead, true);
            
            if (process.env.DEBUG_WASI_PATH === '1') {
                parentPort.postMessage({ 
                    type: 'debug', 
                    msg: `WASI fd_read CUSTOM: fd=${fd}, read ${totalRead} bytes` 
                });
            }
            return 0;
        }
        
        // Handle fake directory fds
        if (fakeFdMap.has(fd)) {
            return origFdRead(fakeFdMap.get(fd), iovs_ptr, iovs_len, nread_ptr);
        }
        
        return origFdRead(fd, iovs_ptr, iovs_len, nread_ptr);
    };
    
    // Custom fd_pread (positioned read) for our file handles
    const origFdPread = wasiImport.fd_pread;
    wasiImport.fd_pread = (fd, iovs_ptr, iovs_len, offset, nread_ptr) => {
        // Check if this is one of our custom file handles
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (!instance) return 8; // WASI_ERRNO_BADF
            
            const view = new DataView(instance.exports.memory.buffer);
            const mem = new Uint8Array(instance.exports.memory.buffer);
            
            // offset comes as a BigInt in WASI
            const fileOffset = typeof offset === 'bigint' ? Number(offset) : offset;
            let currentOffset = fileOffset;
            let totalRead = 0;
            
            for (let i = 0; i < iovs_len; i++) {
                const buf_ptr = view.getUint32(iovs_ptr + i * 8, true);
                const buf_len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                
                try {
                    const buffer = Buffer.alloc(buf_len);
                    const bytesRead = fs.readSync(handle.nodeFd, buffer, 0, buf_len, currentOffset);
                    
                    // Copy to WASM memory
                    for (let j = 0; j < bytesRead; j++) {
                        mem[buf_ptr + j] = buffer[j];
                    }
                    totalRead += bytesRead;
                    currentOffset += bytesRead;
                    
                    if (bytesRead < buf_len) break; // EOF or partial read
                } catch (err) {
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({ 
                            type: 'debug', 
                            msg: `WASI fd_pread CUSTOM ERROR: fd=${fd}, offset=${fileOffset}, err=${err.message}` 
                        });
                    }
                    return 29; // WASI_ERRNO_IO
                }
            }
            
            view.setUint32(nread_ptr, totalRead, true);
            
            if (process.env.DEBUG_WASI_PATH === '1') {
                parentPort.postMessage({ 
                    type: 'debug', 
                    msg: `WASI fd_pread CUSTOM: fd=${fd}, offset=${fileOffset}, read ${totalRead} bytes` 
                });
            }
            return 0;
        }
        
        return origFdPread(fd, iovs_ptr, iovs_len, offset, nread_ptr);
    };
    
    // Custom fd_pwrite (positioned write) for our file handles
    const origFdPwrite = wasiImport.fd_pwrite;
    wasiImport.fd_pwrite = (fd, iovs_ptr, iovs_len, offset, nwritten_ptr) => {
        // Check if this is one of our custom file handles
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (!instance) return 8; // WASI_ERRNO_BADF
            
            const view = new DataView(instance.exports.memory.buffer);
            const mem = new Uint8Array(instance.exports.memory.buffer);
            
            const fileOffset = typeof offset === 'bigint' ? Number(offset) : offset;
            let currentOffset = fileOffset;
            let totalWritten = 0;
            
            for (let i = 0; i < iovs_len; i++) {
                const buf_ptr = view.getUint32(iovs_ptr + i * 8, true);
                const buf_len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                
                try {
                    const buffer = Buffer.from(mem.slice(buf_ptr, buf_ptr + buf_len));
                    const bytesWritten = fs.writeSync(handle.nodeFd, buffer, 0, buf_len, currentOffset);
                    
                    totalWritten += bytesWritten;
                    currentOffset += bytesWritten;
                } catch (err) {
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({ 
                            type: 'debug', 
                            msg: `WASI fd_pwrite CUSTOM ERROR: fd=${fd}, offset=${fileOffset}, err=${err.message}` 
                        });
                    }
                    return 29; // WASI_ERRNO_IO
                }
            }
            
            view.setUint32(nwritten_ptr, totalWritten, true);
            
            if (process.env.DEBUG_WASI_PATH === '1') {
                parentPort.postMessage({ 
                    type: 'debug', 
                    msg: `WASI fd_pwrite CUSTOM: fd=${fd}, offset=${fileOffset}, wrote ${totalWritten} bytes` 
                });
            }
            return 0;
        }
        
        return origFdPwrite(fd, iovs_ptr, iovs_len, offset, nwritten_ptr);
    };
    
    // Custom fd_write for our file handles (uses current position)
    const origFdWrite_custom = wasiImport.fd_write;
    wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        // Check if this is one of our custom file handles
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (!instance) return 8; // WASI_ERRNO_BADF
            
            const view = new DataView(instance.exports.memory.buffer);
            const mem = new Uint8Array(instance.exports.memory.buffer);
            
            let totalWritten = 0;
            
            for (let i = 0; i < iovs_len; i++) {
                const buf_ptr = view.getUint32(iovs_ptr + i * 8, true);
                const buf_len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                
                try {
                    const buffer = Buffer.from(mem.slice(buf_ptr, buf_ptr + buf_len));
                    const bytesWritten = fs.writeSync(handle.nodeFd, buffer);
                    totalWritten += bytesWritten;
                } catch (err) {
                    if (process.env.DEBUG_WASI_PATH === '1') {
                        parentPort.postMessage({ 
                            type: 'debug', 
                            msg: `WASI fd_write CUSTOM ERROR: fd=${fd}, err=${err.message}` 
                        });
                    }
                    return 29; // WASI_ERRNO_IO
                }
            }
            
            view.setUint32(nwritten_ptr, totalWritten, true);
            
            if (process.env.DEBUG_WASI_PATH === '1') {
                parentPort.postMessage({ 
                    type: 'debug', 
                    msg: `WASI fd_write CUSTOM: fd=${fd}, wrote ${totalWritten} bytes` 
                });
            }
            return 0;
        }
        
        // Call the original (which handles NET_FD, stdout, stderr)
        return origFdWrite_custom(fd, iovs_ptr, iovs_len, nwritten_ptr);
    };
    
    // Custom fd_close for our handles
    const origFdClose = wasiImport.fd_close;
    wasiImport.fd_close = (fd) => {
        parentPort.postMessage({ type: 'debug', msg: `fd_close(${fd}) called` });
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            // Only close if it's a file handle with a nodeFd (directories don't have one)
            if (handle.type === 'file' && handle.nodeFd !== undefined) {
                try {
                    fs.closeSync(handle.nodeFd);
                } catch (err) { /* ignore */ }
            }
            customFdHandles.delete(fd);
            return 0;
        }
        if (fakeFdMap.has(fd)) {
            fakeFdMap.delete(fd);
            return 0;
        }
        // Handle network socket close
        if (fd === NET_CONN_FD) {
            parentPort.postMessage({ type: 'debug', msg: `fd_close(${fd}) - closing network socket` });
            netStack.closeSocket();
            // Reset connection state so new connections can be accepted
            netConnectionAccepted = false;
            sockRecvBuffer = Buffer.alloc(0);
            return 0;
        }
        return origFdClose(fd);
    };
    
    // Intercept fd operations to redirect fake directory fds
    const wrapFdOp = (name, orig, fdArgIdx = 0) => {
        return (...args) => {
            const fd = args[fdArgIdx];
            if (fakeFdMap.has(fd)) {
                args[fdArgIdx] = fakeFdMap.get(fd);
            }
            return orig(...args);
        };
    };
    
    // Custom fd_readdir for our directory handles
    const origFdReaddir = wasiImport.fd_readdir;
    wasiImport.fd_readdir = (fd, buf_ptr, buf_len, cookie, bufused_ptr) => {
        const hasIt = customFdHandles.has(fd);
        // Check if this is one of our custom directory handles
        if (hasIt) {
            const handle = customFdHandles.get(fd);
            if (!handle || handle.type !== 'directory') {
                return handle ? 54 : 8; // WASI_ERRNO_NOTDIR or WASI_ERRNO_BADF
            }
            if (!instance) {
                return 8; // WASI_ERRNO_BADF
            }
            
            const view = new DataView(instance.exports.memory.buffer);
            const mem = new Uint8Array(instance.exports.memory.buffer);
            
            try {
                const entries = fs.readdirSync(handle.hostPath, { withFileTypes: true });
                const startIdx = typeof cookie === 'bigint' ? Number(cookie) : cookie;
                
                let offset = 0;
                for (let i = startIdx; i < entries.length; i++) {
                    const entry = entries[i];
                    const name = entry.name;
                    const nameBytes = new TextEncoder().encode(name);
                    
                    // WASI dirent structure:
                    // d_next: u64 (8 bytes) at offset 0
                    // d_ino: u64 (8 bytes) at offset 8
                    // d_namlen: u32 (4 bytes) at offset 16
                    // d_type: u8 (1 byte) at offset 20
                    // padding: 3 bytes at offset 21-23
                    // name: starts at offset 24
                    const DIRENT_HEADER_SIZE = 24;
                    const direntSize = DIRENT_HEADER_SIZE + nameBytes.length;
                    
                    if (offset + direntSize > buf_len) {
                        break;
                    }
                    
                    const base = buf_ptr + offset;
                    
                    // d_next is the cookie for the next fd_readdir call (entry index + 1)
                    view.setBigUint64(base, BigInt(i + 1), true);
                    
                    // d_ino - compute a hash of the path as inode
                    const fullPath = require('path').join(handle.hostPath, name);
                    let ino = 0;
                    for (let j = 0; j < fullPath.length; j++) {
                        ino = ((ino << 5) - ino + fullPath.charCodeAt(j)) | 0;
                    }
                    view.setBigUint64(base + 8, BigInt(Math.abs(ino)), true);
                    
                    // d_namlen
                    view.setUint32(base + 16, nameBytes.length, true);
                    
                    // d_type: 0=unknown, 3=dir, 4=file, 7=symlink
                    let dtype = 0;
                    if (entry.isFile()) dtype = 4;
                    else if (entry.isDirectory()) dtype = 3;
                    else if (entry.isSymbolicLink()) dtype = 7;
                    view.setUint8(base + 20, dtype);
                    
                    // 3 bytes padding at offset 21-23
                    view.setUint8(base + 21, 0);
                    view.setUint8(base + 22, 0);
                    view.setUint8(base + 23, 0);
                    
                    // Name starts at offset 24
                    mem.set(nameBytes, base + 24);
                    
                    offset += direntSize;
                }
                
                view.setUint32(bufused_ptr, offset, true);
                return 0;
                
            } catch (err) {
                if (err.code === 'ENOENT') return 44; // WASI_ERRNO_NOENT
                if (err.code === 'EACCES') return 2;  // WASI_ERRNO_ACCES
                return 29; // WASI_ERRNO_IO
            }
        }
        
        if (fakeFdMap.has(fd)) {
            return origFdReaddir(fakeFdMap.get(fd), buf_ptr, buf_len, cookie, bufused_ptr);
        }
        
        console.error(`[fd_readdir] FALLBACK`);
        return origFdReaddir(fd, buf_ptr, buf_len, cookie, bufused_ptr);
    };
    
    // Wrap fd_fdstat_get for custom file handles and debugging
    const origFdstatGet = wasiImport.fd_fdstat_get;
    wasiImport.fd_fdstat_get = (fd, fdstat_ptr) => {
        // Handle our custom file handles
        if (customFdHandles.has(fd)) {
            if (!instance) return 8; // WASI_ERRNO_BADF
            const view = new DataView(instance.exports.memory.buffer);
            const handle = customFdHandles.get(fd);
            
            // fdstat structure: filetype(1) + padding(1) + flags(2) + padding(4) + rights_base(8) + rights_inh(8) = 24 bytes
            // filetype: 4 = REGULAR_FILE, 3 = DIRECTORY
            const fileType = handle.type === 'directory' ? 3 : 4;
            view.setUint8(fdstat_ptr, fileType);
            view.setUint8(fdstat_ptr + 1, 0); // padding
            view.setUint16(fdstat_ptr + 2, 0, true); // fs_flags
            view.setUint32(fdstat_ptr + 4, 0, true); // padding
            // rights_base (full rights)
            view.setUint32(fdstat_ptr + 8, 0x1FFFFFFF, true); // low 32 bits
            view.setUint32(fdstat_ptr + 12, 0, true); // high 32 bits
            // rights_inheriting 
            view.setUint32(fdstat_ptr + 16, 0x1FFFFFFF, true);
            view.setUint32(fdstat_ptr + 20, 0, true);
            
            return 0;
        }
        
        const actualFd = fakeFdMap.has(fd) ? fakeFdMap.get(fd) : fd;
        const result = origFdstatGet(actualFd, fdstat_ptr);
        
        // Debug: show what rights the fd has according to Node.js WASI
        if (process.env.DEBUG_WASI_PATH === '1' && instance && fd >= 3) {
            const view = new DataView(instance.exports.memory.buffer);
            // fdstat structure: filetype(1) + padding(1) + flags(2) + padding(4) + rights_base(8) + rights_inh(8)
            const filetype = view.getUint8(fdstat_ptr);
            const flags = view.getUint16(fdstat_ptr + 2, true);
            // Read 64-bit values as two 32-bit halves
            const rights_base_lo = view.getUint32(fdstat_ptr + 8, true);
            const rights_base_hi = view.getUint32(fdstat_ptr + 12, true);
            const rights_inh_lo = view.getUint32(fdstat_ptr + 16, true);
            const rights_inh_hi = view.getUint32(fdstat_ptr + 20, true);
            
            parentPort.postMessage({ 
                type: 'debug', 
                msg: `WASI fd_fdstat_get(fd=${fd}->${actualFd}) => ${result}, filetype=${filetype}, flags=${flags}, rights_base=0x${rights_base_hi.toString(16)}${rights_base_lo.toString(16).padStart(8,'0')}, rights_inh=0x${rights_inh_hi.toString(16)}${rights_inh_lo.toString(16).padStart(8,'0')}` 
            });
        }
        return result;
    };
    
    wasiImport.fd_filestat_get = wrapFdOp('fd_filestat_get', wasiImport.fd_filestat_get);
    
    // Custom path_filestat_get for our directory handles
    const origPathFilestatGet = wasiImport.path_filestat_get;
    wasiImport.path_filestat_get = (fd, flags, path_ptr, path_len, filestat_ptr) => {
        // Check if fd is one of our custom directory handles
        if (customFdHandles.has(fd)) {
            const handle = customFdHandles.get(fd);
            if (handle.type === 'directory' && instance) {
                const view = new DataView(instance.exports.memory.buffer);
                const mem = new Uint8Array(instance.exports.memory.buffer);
                const pathBytes = mem.slice(path_ptr, path_ptr + path_len);
                const pathStr = new TextDecoder().decode(pathBytes);
                const fullPath = require('path').join(handle.hostPath, pathStr);
                
                require('fs').writeSync(2, `[path_filestat_get] custom fd=${fd}, path="${pathStr}", fullPath="${fullPath}"\n`);
                
                try {
                    const stat = fs.statSync(fullPath);
                    
                    // WASI filestat structure (64 bytes total):
                    // 0: dev (u64)
                    // 8: ino (u64)
                    // 16: filetype (u8)
                    // 17-23: padding
                    // 24: nlink (u64)
                    // 32: size (u64)
                    // 40: atim (u64)
                    // 48: mtim (u64)
                    // 56: ctim (u64)
                    
                    view.setBigUint64(filestat_ptr, BigInt(0), true); // dev
                    view.setBigUint64(filestat_ptr + 8, BigInt(stat.ino || 0), true); // ino
                    
                    // filetype: 0=unknown, 1=block, 2=char, 3=dir, 4=file, 5=socket_dgram, 6=socket_stream, 7=symlink
                    let filetype = 0;
                    if (stat.isFile()) filetype = 4;
                    else if (stat.isDirectory()) filetype = 3;
                    else if (stat.isSymbolicLink()) filetype = 7;
                    view.setUint8(filestat_ptr + 16, filetype);
                    
                    view.setBigUint64(filestat_ptr + 24, BigInt(stat.nlink || 1), true); // nlink
                    view.setBigUint64(filestat_ptr + 32, BigInt(stat.size), true); // size
                    view.setBigUint64(filestat_ptr + 40, BigInt(Math.floor(stat.atimeMs * 1000000)), true); // atim (ns)
                    view.setBigUint64(filestat_ptr + 48, BigInt(Math.floor(stat.mtimeMs * 1000000)), true); // mtim (ns)
                    view.setBigUint64(filestat_ptr + 56, BigInt(Math.floor(stat.ctimeMs * 1000000)), true); // ctim (ns)
                    
                    return 0;
                } catch (err) {
                    require('fs').writeSync(2, `[path_filestat_get] ERROR: ${err.message}\n`);
                    if (err.code === 'ENOENT') return 44; // WASI_ERRNO_NOENT
                    if (err.code === 'EACCES') return 2;  // WASI_ERRNO_ACCES
                    return 29; // WASI_ERRNO_IO
                }
            }
        }
        
        // Fall back to wrapped original
        if (fakeFdMap.has(fd)) {
            return origPathFilestatGet(fakeFdMap.get(fd), flags, path_ptr, path_len, filestat_ptr);
        }
        return origPathFilestatGet(fd, flags, path_ptr, path_len, filestat_ptr);
    };
    
    // Debug: trace path operations for mount debugging
    const DEBUG_WASI_PATH = process.env.DEBUG_WASI_PATH === '1';
    if (DEBUG_WASI_PATH) {
        const pathOps = ['path_filestat_get', 'fd_readdir', 'fd_prestat_get', 'fd_prestat_dir_name'];
        for (const op of pathOps) {
            const orig = wasiImport[op];
            wasiImport[op] = (...args) => {
                const result = orig(...args);
                parentPort.postMessage({ type: 'debug', msg: `WASI ${op}(${args.slice(0,3).join(', ')}) => ${result}` });
                return result;
            };
        }
        
        // Debug all fd_* operations to see what cat uses
        const fdOps = ['fd_read', 'fd_pread', 'fd_seek', 'fd_tell', 'fd_filestat_get', 'fd_fdstat_set_flags'];
        for (const op of fdOps) {
            if (!wasiImport[op]) continue;
            const orig = wasiImport[op];
            wasiImport[op] = (...args) => {
                const result = orig(...args);
                if (args[0] >= 100) { // Our custom fds start at 100
                    parentPort.postMessage({ type: 'debug', msg: `WASI ${op}(fd=${args[0]}, ...) => ${result}` });
                }
                return result;
            };
        }
    }

    // Debug: trace ALL fd operations when DEBUG_WASI_FD=1
    const DEBUG_WASI_FD = process.env.DEBUG_WASI_FD === '1';
    if (DEBUG_WASI_FD) {
        const allFdOps = [
            'fd_read', 'fd_write', 'fd_pread', 'fd_pwrite', 
            'fd_close', 'fd_seek', 'fd_tell', 'fd_sync', 'fd_datasync',
            'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_filestat_get',
            'fd_prestat_get', 'fd_prestat_dir_name', 'fd_readdir',
            'fd_allocate', 'fd_advise', 'fd_renumber', 'fd_filestat_set_size', 'fd_filestat_set_times'
        ];
        for (const op of allFdOps) {
            if (!wasiImport[op]) continue;
            const orig = wasiImport[op];
            wasiImport[op] = (...args) => {
                const result = orig(...args);
                parentPort.postMessage({ type: 'debug', msg: `[FD] ${op}(${args.slice(0,3).join(', ')}) => ${result}` });
                return result;
            };
        }
    }

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
            
            // Poll for network responses before reading
            netStack.pollNetResponses();
            
            // Read larger chunks for better throughput
            const data = netStack.readFromNetwork(65536);
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
                 // Wait for stdin data using ring buffer
                 ringReader.waitForIO(-1); // Block until I/O ready
                 
                 const stdinData = ringReader.readStdin();
                 if (stdinData && stdinData.length > 0) {
                     localBuffer = stdinData;
                 }
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
        let otherFds = [];

        // 1. Scan subscriptions
        for (let i = 0; i < nsubscriptions; i++) {
             const base = in_ptr + i * 48;
             const type = view.getUint8(base + 8);
             if (type === 1) { // FD_READ
                 const fd = view.getUint32(base + 16, true);
                 if (fd === 0) hasStdin = true;
                 else if (fd === NET_FD) {
                     hasNetListen = true;
                 }
                 else if (fd === NET_FD + 1) {
                     hasNetRead = true;
                 }
                 else {
                     otherFds.push(`read:${fd}`);
                 }
             } else if (type === 2) { // FD_WRITE
                 const fd = view.getUint32(base + 16, true);
                 if (fd === NET_FD + 1) {
                     hasNetWrite = true;
                 }
                 else {
                     otherFds.push(`write:${fd}`);
                 }
             } else if (type === 0) { // CLOCK
                 const timeout = view.getBigUint64(base + 24, true);
                 const flags = view.getUint16(base + 40, true);
                 
                 let t = Number(timeout) / 1000000; // to ms
                 if ((flags & 1) === 1) { // ABSOLUTE (not supported properly here, assume relative 0?)
                     t = 0; 
                 }
                 if (t < minTimeout) minTimeout = t;
             }
        }
        
        // Log what we're waiting for
        const pollStart = Date.now();
        parentPort.postMessage({ type: 'debug', msg: `poll_oneoff: hasStdin=${hasStdin}, hasNetRead=${hasNetRead}, hasNetWrite=${hasNetWrite}, timeout=${minTimeout}ms, sockRecvBuf=${sockRecvBuffer.length}, txBuf=${netStack.txBuffer.length}` });
        
        // IMPORTANT: Always poll for network responses first!
        // This ensures TCP data from main thread is received even when 
        // we're polling for both read and write (common during TLS handshake).
        netStack.pollNetResponses();
        
        // 2. Check Immediate Status
        // Include sockRecvBuffer in readability check - it may have data from a previous partial read
        const netReadable = sockRecvBuffer.length > 0 || netStack.hasPendingData() || netStack.hasReceivedFin();
        const netWritable = true; // Always writable
        const stdinReadable = localBuffer.length > 0 || ringReader.hasStdinData();
        
        let ready = false;
        if (hasStdin && stdinReadable) ready = true;
        if (hasNetRead && netReadable) ready = true;
        if (hasNetWrite && netWritable) ready = true;
        
        // 3. Wait if needed
        if (!ready && minTimeout !== 0) {
            // Wait for I/O using the unified ring buffer signal
            // The main thread notifies IO_READY_INDEX when stdin OR network data arrives
            
            let waitTime = 0;
            if (minTimeout !== Infinity) {
                waitTime = Math.max(0, Math.ceil(minTimeout));
            } else {
                waitTime = -1; // Infinite
            }
            
            // Use the ring buffer's efficient wait mechanism
            if (hasStdin || hasNetRead || waitTime > 0) {
                 const t = (waitTime === -1) ? 30000 : waitTime; // Max 30s for "infinite"
                 const startTime = Date.now();
                 
                 while (true) {
                     const elapsed = Date.now() - startTime;
                     if (elapsed >= t) break;
                     
                     // Poll for network responses from ring buffer (no busy-wait needed!)
                     netStack.pollNetResponses();
                     
                     // Check if stdin became available
                     if (hasStdin && ringReader.hasStdinData()) break;
                     
                     // Check if network data became available (including buffered data)
                     if (sockRecvBuffer.length > 0 || netStack.hasPendingData() || netStack.hasReceivedFin()) break;
                     
                     // Check if there's more network data in the ring buffer
                     if (ringReader.hasNetworkData()) {
                         continue; // More data to process, don't sleep
                     }
                     
                     // Block efficiently until I/O is ready (stdin OR network)
                     // This uses Atomics.wait which wakes instantly when notified
                     const remaining = Math.max(1, t - elapsed);
                     ringReader.waitForIO(Math.min(10, remaining)); // Short waits for responsiveness
                 }
            }
        }
        
        // 4. Populate Events
        let eventsWritten = 0;
        
        // Refresh status (include sockRecvBuffer in check)
        const postStdinReadable = localBuffer.length > 0 || ringReader.hasStdinData();
        const postNetReadable = sockRecvBuffer.length > 0 || netStack.hasPendingData() || netStack.hasReceivedFin();
        
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
        const pollDuration = Date.now() - pollStart;
        if (pollDuration > 5) {
            parentPort.postMessage({ type: 'debug', msg: `poll_oneoff completed in ${pollDuration}ms, events=${eventsWritten}` });
        }
        return 0; // Success
    };



    const { instance: inst } = await WebAssembly.instantiate(wasmBuffer, {
        wasi_snapshot_preview1: {
            ...wasiImport,
            // WASI Socket Extensions (for network support)
            sock_accept: (fd, flags, result_fd_ptr) => {
                // Poll for network responses first - TCP-connected messages may be pending
                netStack.pollNetResponses();
                
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
                // Poll for network responses first
                netStack.pollNetResponses();
                
                parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) called, sockRecvBuf=${sockRecvBuffer.length}, txBuf=${netStack.txBuffer.length}, fin=${netStack.hasReceivedFin()}` });
                
                if (fd !== NET_CONN_FD) {
                    // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) - wrong fd` });
                    return 8; // WASI_ERRNO_BADF
                }
                
                if (!instance) return 0;
                const view = new DataView(instance.exports.memory.buffer);
                
                // First check if we have buffered data from a previous partial read
                if (sockRecvBuffer.length === 0) {
                    // Read larger chunks for better throughput - the VM will consume what it needs
                    const data = netStack.readFromNetwork(65536);
                    parentPort.postMessage({ type: 'debug', msg: `sock_recv readFromNetwork returned ${data ? data.length : 'null'} bytes, txBuf now=${netStack.txBuffer.length}` });
                    if (!data || data.length === 0) {
                        // Check if FIN was received - if so, return EOF (0 bytes) instead of EAGAIN
                        if (netStack.hasReceivedFin()) {
                            parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) returning EOF due to FIN` });
                            view.setUint32(ro_datalen_ptr, 0, true);
                            view.setUint16(ro_flags_ptr, 0, true);
                            // Clean up the connection to allow new connections
                            netStack.closeSocket();
                            netConnectionAccepted = false;
                            sockRecvBuffer = Buffer.alloc(0);
                            return 0; // Success with 0 bytes = EOF
                        }
                        parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) returning EAGAIN` });
                        view.setUint32(ro_datalen_ptr, 0, true);
                        view.setUint16(ro_flags_ptr, 0, true);
                        // Return EAGAIN to indicate no data available yet
                        return 6; // WASI_ERRNO_AGAIN
                    }
                    sockRecvBuffer = data;
                }
                
                // parentPort.postMessage({ type: 'debug', msg: `sock_recv(${fd}) have ${sockRecvBuffer.length} bytes to deliver` });
                
                // Write data to iovec buffers
                const bytesWritten = writeIOVs(view, ri_data_ptr, ri_data_len, sockRecvBuffer);
                
                // Debug: show how much we wrote vs how much we had
                parentPort.postMessage({ type: 'debug', msg: `sock_recv wrote ${bytesWritten}/${sockRecvBuffer.length} bytes to ${ri_data_len} iovecs` });
                
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
                parentPort.postMessage({ type: 'debug', msg: `sock_shutdown(${fd}, ${how})` });
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

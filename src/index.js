const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Buffer layout:
// Int32[0]: Flag (0 = Free/Empty, 1 = Data Ready)
// Int32[1]: Data Length
// Offset 8: Data Bytes
const SHARED_BUFFER_SIZE = 64 * 1024; // 64KB

class AgentVM {
    /**
     * @param {Object} options
     * @param {string} [options.wasmPath] - Path to the .wasm file.
     */
    constructor(options = {}) {
        this.wasmPath = options.wasmPath || path.resolve(__dirname, '../agentvm-alpine-python.wasm');
        this.mounts = options.mounts || {};
        this.sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
        this.inputInt32 = new Int32Array(this.sharedBuffer);
        this.inputData = new Uint8Array(this.sharedBuffer, 8);
        
        this.worker = null;
        this.pendingCommand = null; // { resolve, reject, marker, outputStr, stderrStr }
        this.isReady = false;
        this.destroyed = false;
    }

    async start() {
        if (this.worker) return;

        return new Promise((resolve, reject) => {
            this.worker = new Worker(path.join(__dirname, 'worker.js'), {
                workerData: {
                    wasmPath: this.wasmPath,
                    mounts: this.mounts,
                    sharedInputBuffer: this.sharedBuffer
                }
            });

            this.worker.on('message', (msg) => {
                if (msg.type === 'ready') {
                    this.isReady = true;
                    // Run setup commands
                    this.exec("stty -echo; export PS1=''").then(() => {
                         resolve();
                    }).catch(err => {
                         console.warn("Failed to configure shell:", err);
                         resolve();
                    });
                } else if (msg.type === 'stdout') {
                    this.handleOutput('stdout', msg.data);
                } else if (msg.type === 'stderr') {
                    this.handleOutput('stderr', msg.data);
                } else if (msg.type === 'debug') {
                    console.log('[Worker Debug]', msg.msg);
                } else if (msg.type === 'exit') {
                    if (!this.destroyed) {
                        console.error('VM Exited unexpectedly:', msg.error);
                    }
                }
            });

            this.worker.on('error', (err) => {
                if (this.pendingCommand) this.pendingCommand.reject(err);
                reject(err);
            });
            
            this.worker.on('exit', (code) => {
                this.isReady = false;
                if (this.pendingCommand) {
                    this.pendingCommand.reject(new Error(`VM exited with code ${code} before command completion`));
                    this.pendingCommand = null;
                }
                if (code !== 0 && !this.destroyed) {
                     console.error(`VM Worker exited with code ${code}`);
                }
            });
        });
    }

    async stop() {
        this.destroyed = true;
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
    }

    /**
     * Executes a command in the VM.
     * @param {string} command 
     * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
     */
    async exec(command) {
        if (!this.isReady) throw new Error("VM not ready");
        if (this.pendingCommand) throw new Error("VM is busy");

        const id = randomUUID();
        const marker = `__AVM_DONE:${id}`;
        // Use printf to avoid marker appearing in echo
        // \137 is octal for '_'
        const shellCmd = `${command}\nprintf "\\137_AVM_DONE:${id}:$?\\n"\n`;

        return new Promise((resolve, reject) => {
            this.pendingCommand = {
                resolve,
                reject,
                marker,
                stdoutStr: '',
                stderrStr: ''
            };
            this.writeToStdin(shellCmd).catch(reject);
        });
    }

    async writeToStdin(data) {
        const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        let offset = 0;
        const CHUNK_SIZE = SHARED_BUFFER_SIZE - 16;

        while (offset < encoded.length) {
            // Wait for buffer to be free (0)
            // We use a polling loop to avoid blocking the main thread event loop
            while (Atomics.load(this.inputInt32, 0) !== 0) {
                await new Promise(r => setTimeout(r, 5));
            }

            const chunk = encoded.subarray(offset, offset + CHUNK_SIZE);
            this.inputData.set(chunk);
            this.inputInt32[1] = chunk.length;
            
            // Mark as Ready (1)
            Atomics.store(this.inputInt32, 0, 1);
            
            // Wake up worker
            Atomics.notify(this.inputInt32, 0);
            
            offset += chunk.length;
        }
    }

    handleOutput(type, dataUint8) {
        const text = new TextDecoder().decode(dataUint8); // Assuming UTF-8 valid chunks
        
        // Debug
        // console.log(`[VM ${type}]`, JSON.stringify(text));

        if (!this.pendingCommand) return;

        if (type === 'stdout') {
            this.pendingCommand.stdoutStr += text;
            
            // Check for marker
            const markerIdx = this.pendingCommand.stdoutStr.indexOf(this.pendingCommand.marker);
            if (markerIdx !== -1) {
                // Cut everything before marker as stdout
                const finalStdout = this.pendingCommand.stdoutStr.substring(0, markerIdx);
                
                // Extract rest
                const rest = this.pendingCommand.stdoutStr.substring(markerIdx);
                // Rest string: `__AVM_DONE:uuid:0`
                // Split by :
                const parts = rest.trim().split(':');
                const exitCode = parseInt(parts[parts.length - 1], 10);

                const result = {
                    stdout: finalStdout.trim(), // Trim output
                    stderr: this.pendingCommand.stderrStr,
                    exitCode: isNaN(exitCode) ? 0 : exitCode
                };
                
                const resolver = this.pendingCommand.resolve;
                this.pendingCommand = null;
                resolver(result);
            }
        } else {
            this.pendingCommand.stderrStr += text;
        }
    }
}

module.exports = { AgentVM };

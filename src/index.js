const { Worker, MessageChannel, SHARE_ENV } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const dgram = require('node:dgram');

// Buffer layout:
// Int32[0]: Flag (0 = Free/Empty, 1 = Data Ready)
// Int32[1]: Data Length
// Int32[2]: Network signal (incremented when network data arrives)
// Offset 12: Data Bytes (after 3 Int32s = 12 bytes)
const SHARED_BUFFER_SIZE = 64 * 1024; // 64KB
const NET_SIGNAL_INDEX = 2; // Index for network wake signal

class AgentVM {
    /**
     * @param {Object} options
     * @param {string} [options.wasmPath] - Path to the .wasm file.
     * @param {Object.<string, string>} [options.mounts] - Mount points mapping VM path to host path (e.g., {'/mnt/data': '/host/path'}).
     * @param {boolean} [options.network] - Enable networking (default: true).
     * @param {string} [options.mac] - MAC address for the VM (default: 02:00:00:00:00:01).
     * @param {number} [options.networkRateLimit] - Network rate limit in bytes/sec (default: 256KB/s). Set to 0 for unlimited.
     * @param {boolean} [options.debug] - Enable debug logging.
     * @param {boolean} [options.interactive] - Interactive/raw mode - skip shell setup for direct terminal access.
     */
    constructor(options = {}) {
        this.wasmPath = options.wasmPath || path.resolve(__dirname, '../agentvm-alpine-python.wasm');
        this.mounts = options.mounts || {};
        this.network = options.network !== false; // Default to true
        this.mac = options.mac || '02:00:00:00:00:01';
        this.debug = options.debug || false;
        this.interactive = options.interactive || false;
        // Rate limit to avoid overwhelming VM filesystem writes
        this.networkRateLimit = options.networkRateLimit !== undefined ? options.networkRateLimit :  1024 * 1024 * 1024;
        this.sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
        this.inputInt32 = new Int32Array(this.sharedBuffer);
        this.inputData = new Uint8Array(this.sharedBuffer, 12); // Offset 12 (after 3 Int32s)
        
        this.worker = null;
        this.pendingCommand = null; // { resolve, reject, marker, outputStr, stderrStr }
        this.isReady = false;
        this.destroyed = false;
        
        // Callbacks for raw/interactive mode
        this.onStdout = null;
        this.onStderr = null;
        this.onExit = null;
        
        // NAT: Main thread handles sockets, worker polls for responses via MessageChannel
        this.udpSessions = new Map(); // key -> { socket, lastActive }
        this.tcpSessions = new Map(); // key -> { socket, state, bytesThisSecond, lastReset, paused, pendingData }
        this.netChannel = null;
    }

    async start() {
        if (this.worker) return;
        
        // Create MessageChannel for network communication (UDP + TCP)
        this.netChannel = new MessageChannel();
        
        // Handle network requests from worker
        this.netChannel.port2.on('message', (msg) => {
            if (msg.type === 'udp-send') {
                this._handleUdpSend(msg);
            } else if (msg.type === 'tcp-connect') {
                this._handleTcpConnect(msg);
            } else if (msg.type === 'tcp-send') {
                this._handleTcpSend(msg);
            } else if (msg.type === 'tcp-close') {
                this._handleTcpClose(msg);
            } else if (msg.type === 'tcp-pause') {
                this._handleTcpPause(msg);
            } else if (msg.type === 'tcp-resume') {
                this._handleTcpResume(msg);
            }
        });

        return new Promise((resolve, reject) => {
            this.worker = new Worker(path.join(__dirname, 'worker.js'), {
                workerData: {
                    wasmPath: this.wasmPath,
                    mounts: this.mounts,
                    sharedInputBuffer: this.sharedBuffer,
                    network: this.network,
                    mac: this.mac,
                    netPort: this.netChannel.port1
                },
                transferList: [this.netChannel.port1],
                env: SHARE_ENV  // Share environment variables with worker thread
            });

            this.worker.on('message', (msg) => {
                if (msg.type === 'ready') {
                    this.isReady = true;
                    
                    // In interactive mode, skip shell setup and resolve immediately
                    if (this.interactive) {
                        resolve();
                        return;
                    }
                    
                    // Run setup commands for exec() mode
                    this.exec("stty -echo; export PS1=''").then(async () => {
                         // Auto-setup network if enabled
                         if (this.network) {
                             try {
                                 await this.setupNetwork();
                             } catch (err) {
                                 console.warn("Failed to setup network:", err.message);
                             }
                         }
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
                    // Worker debug messages
                    if (this.debug) console.log('[Worker]', msg.msg);
                } else if (msg.type === 'exit') {
                    if (!this.destroyed && !this.interactive) {
                        console.error('VM Exited unexpectedly:', msg.error);
                    }
                    // In interactive mode, trigger onExit callback
                    if (this.interactive && this.onExit) {
                        this.onExit(msg.error);
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

    /**
     * Sets up the network interface. Called automatically during start() if network is enabled.
     * Can also be called manually to re-initialize the network.
     * @returns {Promise<{ip: string, gateway: string}>} Network configuration
     */
    async setupNetwork() {
        if (!this.network) {
            throw new Error('Network is not enabled');
        }
        
        // Bring up eth0
        await this.exec('ip link set eth0 up');
        
        // Run DHCP client (with timeout to avoid hanging)
        const dhcpResult = await this.exec('timeout 15 udhcpc -i eth0 -s /sbin/udhcpc.script 2>&1');
        
        // Extract IP address
        const ipMatch = dhcpResult.stdout.match(/lease of ([\d.]+) obtained/);
        const ip = ipMatch ? ipMatch[1] : null;
        
        // Get gateway from routing table
        const routeResult = await this.exec('ip route | grep default');
        const gwMatch = routeResult.stdout.match(/via ([\d.]+)/);
        const gateway = gwMatch ? gwMatch[1] : null;
        
        return { ip, gateway };
    }

    async stop() {
        this.destroyed = true;
        
        // Close all UDP sockets
        for (const [key, session] of this.udpSessions) {
            try {
                session.socket.close();
            } catch (e) {}
        }
        this.udpSessions.clear();
        
        // Close all TCP sockets
        for (const [key, session] of this.tcpSessions) {
            try {
                session.socket.destroy();
            } catch (e) {}
        }
        this.tcpSessions.clear();
        
        // Close network channel
        if (this.netChannel) {
            this.netChannel.port2.close();
            this.netChannel = null;
        }
        
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
    }
    
    /**
     * Handle UDP send request from worker
     * @private
     */
    _handleUdpSend(msg) {
        const { key, dstIP, dstPort, payload, srcIP, srcPort } = msg;
        
        let session = this.udpSessions.get(key);
        if (!session) {
            const socket = dgram.createSocket('udp4');
            session = { socket, lastActive: Date.now(), srcIP, srcPort, dstIP, dstPort };
            this.udpSessions.set(key, session);
            
            socket.on('message', (data, rinfo) => {
                // Send response back to worker
                this.netChannel.port2.postMessage({
                    type: 'udp-recv',
                    key,
                    data: Array.from(data),
                    fromIP: rinfo.address,
                    fromPort: rinfo.port,
                    srcIP,
                    srcPort,
                    dstIP,
                    dstPort
                });
            });
            
            socket.on('error', (err) => {
                console.error(`UDP socket error for ${key}:`, err.message);
            });
        }
        
        session.lastActive = Date.now();
        const payloadBuf = Buffer.from(payload);
        session.socket.send(payloadBuf, dstPort, dstIP);
    }
    
    /**
     * Handle TCP connect request from worker
     * @private
     */
    _handleTcpConnect(msg) {
        const { key, dstIP, dstPort, srcIP, srcPort } = msg;
        const net = require('net');
        
        // Translate gateway IP to localhost for local server access
        const connectIP = (dstIP === '192.168.127.1') ? '127.0.0.1' : dstIP;
        
        const socket = new net.Socket();
        const session = { 
            socket, srcIP, srcPort, dstIP, dstPort,
            // Rate limiting state
            bytesThisSecond: 0,
            lastReset: Date.now(),
            rateLimitPaused: false,
            flowControlPaused: false,  // Track flow control state
            pendingResume: null
        };
        this.tcpSessions.set(key, session);
        
        if (this.debug) {
            console.log(`[TCP] Connecting to ${connectIP}:${dstPort}, key=${key}`);
        }
        
        socket.connect(dstPort, connectIP, () => {
            if (!this.netChannel) return;
            this.netChannel.port2.postMessage({
                type: 'tcp-connected',
                key
            });
        });
        
        socket.on('data', (data) => {
            if (!this.netChannel) return;
            
            // Rate limiting: track bytes per second
            if (this.networkRateLimit > 0) {
                const now = Date.now();
                // Reset counter every second
                if (now - session.lastReset >= 1000) {
                    session.bytesThisSecond = 0;
                    session.lastReset = now;
                }
                
                session.bytesThisSecond += data.length;
                
                // If we've exceeded rate limit, pause the socket
                if (session.bytesThisSecond >= this.networkRateLimit && !session.rateLimitPaused) {
                    session.rateLimitPaused = true;
                    socket.pause();
                    if (this.debug) {
                        console.log(`[RateLimit] Pausing ${key}, sent ${session.bytesThisSecond} bytes this second`);
                    }
                    
                    // Schedule resume at start of next second
                    const timeUntilNextSecond = 1000 - (now - session.lastReset);
                    session.pendingResume = setTimeout(() => {
                        // Always clear the rate limit pause flag and reset counters
                        session.rateLimitPaused = false;
                        session.bytesThisSecond = 0;
                        session.lastReset = Date.now();
                        session.pendingResume = null;
                        
                        // Only actually resume if flow control also allows it
                        if (!session.flowControlPaused) {
                            socket.resume();
                            if (this.debug) {
                                console.log(`[RateLimit] Resuming ${key}`);
                            }
                        } else if (this.debug) {
                            console.log(`[RateLimit] Rate limit cleared for ${key}, but flow control still paused`);
                        }
                    }, timeUntilNextSecond);
                }
            }
            
            // Send data immediately to worker - batching caused delivery delays
            try {
                const copy = new Uint8Array(data.length);
                copy.set(data);
                this.netChannel.port2.postMessage({
                    type: 'tcp-data',
                    key,
                    data: copy
                }, [copy.buffer]);
                
                // Signal the worker that network data is available
                Atomics.add(this.inputInt32, NET_SIGNAL_INDEX, 1);
                Atomics.notify(this.inputInt32, NET_SIGNAL_INDEX);
            } catch (e) {
                // Fallback without transfer
                this.netChannel.port2.postMessage({
                    type: 'tcp-data',
                    key,
                    data: new Uint8Array(data)
                });
                Atomics.add(this.inputInt32, NET_SIGNAL_INDEX, 1);
                Atomics.notify(this.inputInt32, NET_SIGNAL_INDEX);
            }
        });
        
        socket.on('end', () => {
            if (!this.netChannel) return;
            this.netChannel.port2.postMessage({
                type: 'tcp-end',
                key
            });
        });
        
        socket.on('close', () => {
            // Clean up timers
            if (session.pendingResume) {
                clearTimeout(session.pendingResume);
                session.pendingResume = null;
            }
            if (this.netChannel) {
                this.netChannel.port2.postMessage({
                    type: 'tcp-close',
                    key
                });
            }
            this.tcpSessions.delete(key);
        });
        
        socket.on('error', (err) => {
            // Clean up timers
            if (session.pendingResume) {
                clearTimeout(session.pendingResume);
                session.pendingResume = null;
            }
            if (this.netChannel) {
                this.netChannel.port2.postMessage({
                    type: 'tcp-error',
                    key,
                    error: err.message
                });
            }
            this.tcpSessions.delete(key);
        });
    }
    
    /**
     * Handle TCP send request from worker
     * @private
     */
    _handleTcpSend(msg) {
        const { key, data } = msg;
        const session = this.tcpSessions.get(key);
        if (session && session.socket.writable) {
            session.socket.write(Buffer.from(data));
        }
    }
    
    /**
     * Handle TCP close request from worker
     * @private
     */
    _handleTcpClose(msg) {
        const { key, destroy } = msg;
        if (this.debug) {
            console.log(`[TCP] Close request for ${key}, destroy=${destroy}`);
        }
        const session = this.tcpSessions.get(key);
        if (session) {
            if (destroy) {
                session.socket.destroy();
            } else {
                session.socket.end();
            }
        }
    }
    
    /**
     * Handle TCP pause request from worker (flow control)
     * @private
     */
    _handleTcpPause(msg) {
        const { key } = msg;
        const session = this.tcpSessions.get(key);
        if (session && session.socket) {
            session.flowControlPaused = true;
            session.socket.pause();
        }
    }
    
    /**
     * Handle TCP resume request from worker (flow control)
     * @private
     */
    _handleTcpResume(msg) {
        const { key } = msg;
        const session = this.tcpSessions.get(key);
        if (session && session.socket) {
            session.flowControlPaused = false;
            // Only resume if not also rate-limit paused
            if (!session.rateLimitPaused) {
                session.socket.resume();
            }
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

        // In interactive mode, call callbacks directly
        if (this.interactive) {
            if (type === 'stdout' && this.onStdout) {
                this.onStdout(dataUint8);
            } else if (type === 'stderr' && this.onStderr) {
                this.onStderr(dataUint8);
            }
            return;
        }

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

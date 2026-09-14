const { Worker, MessageChannel, SHARE_ENV } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');
const fs = require('node:fs');
const { RingBufferWriter, TOTAL_BUFFER_SIZE, IO_READY_INDEX, STDIN_FLAG_INDEX, STDIN_AREA_SIZE } = require('./ringbuffer');
const { normalizeFirewall, matchFirewall, remoteMatches, isHostname, portMatches } = require('./firewall');

const GATEWAY_IP = '192.168.127.1';
const GUEST_IP = '192.168.127.3';

class AgentVM {
    /**
     * @param {Object} options
     * @param {string} [options.wasmPath] - Path to the .wasm file.
     * @param {Object.<string, string>} [options.mounts] - Mount points mapping VM path to host path (e.g., {'/mnt/data': '/host/path'}).
     * @param {boolean} [options.network] - Enable networking (default: true).
     * @param {string} [options.mac] - MAC address for the VM (default: 02:00:00:00:00:01).
     * @param {number} [options.networkRateLimit] - VM-wide network rate limit in bytes/sec (default: 2MiB/s). Set to 0 for unlimited.
     * @param {boolean} [options.debug] - Enable debug logging.
     * @param {boolean} [options.interactive] - Interactive/raw mode - skip shell setup for direct terminal access.
     * @param {boolean} [options.persistentRoot] - Persist the guest root filesystem per workspace via a non-9p ext4 overlay upperdir (default: false). Requires a `/workspace` mount and an image with a second virtio block device.
     * @param {string} [options.persistentRootDir] - HOST directory where the overlay image (`upper.img`) lives. Defaults to `<workspaceHost>/.agentvm` when a `/workspace` mount is present, otherwise it must be supplied.
     */
    constructor(options = {}) {
        this.wasmPath = options.wasmPath || path.resolve(__dirname, '../agentvm-alpine-python.wasm');
        this.mounts = options.mounts || {};
        this.network = options.network !== false; // Default to true
        this.networkEnabled = this.network;
        this.mac = options.mac || '02:00:00:00:00:01';
        this.debug = options.debug || false;
        this.interactive = options.interactive || false;
        this.persistentRoot = options.persistentRoot || false;
        this.persistentRootDir = options.persistentRootDir || null;
        this.persistentRootGuestDir = null;
        this.persistentRootHostDir = null;
        this.persistentRootUpperImgHost = null;
        this.persistentRootUpperImgGuest = null;
        this.rootPersistenceMode = this.persistentRoot ? 'overlay' : 'none';
        this.firewall = { default: 'allow', rules: [] };
        this.portForwards = new Map(); // hostPort -> { hostPort, guestPort, guestHost, protocol, bind, server }
        this.pendingTcpConnects = new Set();
        this.nextIncomingPort = 40000;
        this.usedIncomingPorts = new Set();
        this._hostnameRuleCache = new Map(); // hostname -> { ips, expiresAt }
        // TinyEMU's virtio NIC can stop making progress when dozens of flows
        // deliver at native-host speed. A 2 MiB/s VM-wide default is high
        // enough for single downloads while still safe for npm's concurrent
        // fetches; it was validated at 30x1MiB and 50x512KiB with DNS after.
        this.networkRateLimit = options.networkRateLimit !== undefined
            ? options.networkRateLimit
            : 2 * 1024 * 1024;
        
        // Use the new ring buffer layout
        this.sharedBuffer = new SharedArrayBuffer(TOTAL_BUFFER_SIZE);
        this.ringWriter = new RingBufferWriter(this.sharedBuffer);
        this.int32 = new Int32Array(this.sharedBuffer);
        
        this.worker = null;
        this.pendingCommand = null; // { resolve, reject, marker, outputStr, stderrStr }
        this.pendingInternal = null; // internal shell command output capture (both modes)
        this.pendingBootstrap = null; // pivot/chroot bootstrap output capture
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
        this.pendingRingEvents = [];
        this.ringFlushTimer = null;
        this.networkWindowStarted = Date.now();
        this.networkBytesThisWindow = 0;
        this.networkRateLimited = false;
        this.networkRateTimer = null;
    }

    /**
     * Enable or disable all guest networking at runtime.
     * Disabling drops every live TCP/UDP host socket immediately; the guest
     * keeps its DHCP lease and interface, so new connections simply stall or
     * (for port-forwarded services) stop accepting.
     * @param {boolean} enabled
     */
    setNetworkEnabled(enabled) {
        this.networkEnabled = !!enabled;
        if (enabled) return;

        for (const [key, session] of this.tcpSessions) {
            try { session.socket.destroy(); } catch (e) {}
            this._releaseTcpSession(session);
            this._enqueueRingEvent(() => this.ringWriter.writeTcpError(key, 'network disabled'));
        }
        this.tcpSessions.clear();
        for (const [, session] of this.udpSessions) {
            try { session.socket.close(); } catch (e) {}
        }
        this.udpSessions.clear();
        this.pendingTcpConnects.clear();
    }

    /**
     * Install a firewall configuration. Rules are ordered, first match wins.
     * @param {{default?: 'allow'|'deny', rules: Array<Object>}} config
     */
    setFirewall(config) {
        this.firewall = normalizeFirewall(config);
        this._hostnameRuleCache.clear();
    }

    /**
     * Remove all firewall rules and restore the default action to allow.
     */
    clearFirewall() {
        this.firewall = { default: 'allow', rules: [] };
        this._hostnameRuleCache.clear();
    }

    /**
     * Resolve a non-wildcard hostname firewall remote to its current IPs,
     * caching briefly so per-connection DNS lookups do not become a bottleneck.
     * @param {string} hostname
     * @returns {Promise<string[]>}
     */
    async _resolveHostnameRule(hostname) {
        const cached = this._hostnameRuleCache.get(hostname);
        if (cached && cached.expiresAt > Date.now()) return cached.ips;
        const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
        const ips = results.map((r) => r.address);
        this._hostnameRuleCache.set(hostname, { ips, expiresAt: Date.now() + 60000 });
        return ips;
    }

    /**
     * Evaluate the firewall for a flow. Hostname rules are matched against the
     * optional hostname first and, when a remote IP is available, resolved and
     * compared against IP-based rules.
     * @returns {Promise<'allow'|'deny'>}
     */
    async _evaluateFirewall(direction, protocol, remoteIP, port, hostname) {
        // Iterate the rules in order so first-match-wins is preserved even when
        // a non-wildcard hostname rule has to be resolved to an IP.
        for (const rule of this.firewall.rules) {
            if (rule.direction !== direction || rule.protocol !== protocol) continue;
            if (!portMatches(rule.port, port)) continue;
            if (remoteMatches(rule.remote, remoteIP || null, hostname || null)) {
                return rule.action;
            }
            // A non-wildcard hostname rule can also match a resolved IP. This is
            // what makes `remote: "example.com"` block a direct connection to the
            // same host after the guest has already resolved it.
            if (remoteIP && isHostname(rule.remote) && !rule.remote.includes('*')) {
                try {
                    const ips = await this._resolveHostnameRule(rule.remote);
                    if (ips.includes(remoteIP)) return rule.action;
                } catch (err) {
                    // Resolution failure should not change the firewall result.
                }
            }
        }
        return this.firewall.default;
    }

    /**
     * Synchronous firewall evaluation for IP/CIDR/port rules only. Hostname
     * rules that cannot be resolved are not applied here (DNS lookups and the
     * async TCP path handle those).
     */
    _matchFirewallSync(direction, protocol, remoteIP, port, hostname) {
        return matchFirewall(this.firewall, { direction, protocol, remoteIP, port, hostname });
    }

    async start() {
        if (this.worker) return;
        if (this.persistentRoot) this._preparePersistentRoot();
        
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
            } else if (msg.type === 'udp-close') {
                this._handleUdpClose(msg);
            } else if (msg.type === 'dns-lookup') {
                this._handleDnsLookup(msg);
            } else if (msg.type === 'tcp-pause') {
                this._handleTcpFlowControl(msg.key, true);
            } else if (msg.type === 'tcp-resume') {
                this._handleTcpFlowControl(msg.key, false);
            }
        });

        return new Promise((resolve, reject) => {
            this.worker = new Worker(path.join(__dirname, 'worker.js'), {
                workerData: {
                    wasmPath: this.wasmPath,
                    mounts: this.mounts,
                    sharedBuffer: this.sharedBuffer,
                    network: this.network,
                    mac: this.mac,
                    netPort: this.netChannel.port1,  // Still needed for worker → main control messages
                    persistentRootHostDir: this.persistentRoot ? this.persistentRootHostDir : null,
                },
                transferList: [this.netChannel.port1],
                env: SHARE_ENV  // Share environment variables with worker thread
            });

            this.worker.on('message', (msg) => {
                if (msg.type === 'ready') {
                    this.isReady = true;
                    this._handleReady().then(resolve).catch((err) => {
                        console.warn('Failed to configure VM:', err.message);
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
                if (this.pendingInternal) this.pendingInternal.reject(err);
                if (this.pendingBootstrap) this.pendingBootstrap.reject(err);
                reject(err);
            });
            
            this.worker.on('exit', (code) => {
                this.isReady = false;
                if (this.pendingCommand) {
                    this.pendingCommand.reject(new Error(`VM exited with code ${code} before command completion`));
                    this.pendingCommand = null;
                }
                if (this.pendingInternal) {
                    this.pendingInternal.reject(new Error(`VM exited with code ${code} during internal command`));
                }
                if (this.pendingBootstrap) {
                    this.pendingBootstrap.reject(new Error(`VM exited with code ${code} during bootstrap`));
                }
                if (code !== 0 && !this.destroyed) {
                     console.error(`VM Worker exited with code ${code}`);
                }
            });
        });
    }

    /**
     * Called once the guest shell is ready. Restores a persisted snapshot when
     * enabled, then performs the exec-mode shell setup (interactive mode
     * resolves immediately after restore).
     * @private
     */
    async _handleReady() {
        if (this.persistentRoot) {
            try {
                await this._mountPersistentRoot();
            } catch (err) {
                console.warn('[AgentVM] persistent root mount failed:', err.message);
            }
        }

        if (this.interactive) return;
        await this.exec("stty -echo; export PS1=''");

        // Auto-setup network if the VM has a NIC and the runtime network
        // toggle is currently enabled.
        if (this.network && this.networkEnabled) {
            try {
                await this.setupNetwork();
            } catch (err) {
                console.warn('Failed to setup network:', err.message);
            }
        }
    }

    /**
     * Create the per-workspace persistence directory on the host. The guest
     * sees it through the existing `/workspace` 9p mount, which makes it
     * automatically per-workspace.
     * @private
     */
    _preparePersistentRoot() {
        // Persistence is a first-class HOST path, independent of the live
        // /workspace 9p share. When no explicit host path is supplied, default
        // to a sibling of the workspace mount so it remains per-workspace.
        let hostDir;
        if (this.persistentRootDir) {
            hostDir = path.resolve(this.persistentRootDir);
        } else {
            const workspaceHost = this.mounts['/workspace'];
            if (!workspaceHost) {
                throw new Error('persistentRoot requires persistentRootDir (a host path) when no "/workspace" mount is configured');
            }
            hostDir = path.join(path.resolve(workspaceHost), '.agentvm');
        }
        fs.mkdirSync(hostDir, { recursive: true });

        // The second virtio block device is backed by a sparse host file. Keep
        // a fixed 512 MiB for now; the guest formats it ext4 on first boot.
        const upperHost = path.join(hostDir, 'upper.img');
        if (!fs.existsSync(upperHost)) {
            const fd = fs.openSync(upperHost, 'w');
            fs.ftruncateSync(fd, 512 * 1024 * 1024);
            fs.closeSync(fd);
        }

        // A dedicated WASI preopen path for the persistence image, so it never
        // collides with the workspace 9p mount.
        this.persistentRootGuestDir = '/agentvm-persist';
        this.persistentRootHostDir = hostDir;
        this.persistentRootUpperImgHost = upperHost;
        this.persistentRootUpperImgGuest = `${this.persistentRootGuestDir}/upper.img`;
    }

    /**
     * Run an internal shell command in either exec or interactive mode. Output
     * is captured with a unique marker so the caller knows when it finishes.
     * @param {string} command
     * @param {number} [timeoutMs]
     * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
     * @private
     */
    _execInternal(command, timeoutMs = 30000) {
        const id = randomUUID();
        const marker = `__AGENTVM_INTERNAL:${id}`;
        const shellCmd = `${command}\nprintf "\\137_AGENTVM_INTERNAL:${id}:$?\\n"\n`;

        return new Promise((resolve, reject) => {
            const internal = {
                marker,
                stdoutStr: '',
                stderrStr: '',
                resolve: null,
                reject: null,
            };
            const timer = setTimeout(() => {
                if (this.pendingInternal === internal) {
                    this.pendingInternal = null;
                    reject(new Error('internal command timed out'));
                }
            }, timeoutMs);
            internal.resolve = (result) => {
                clearTimeout(timer);
                this.pendingInternal = null;
                resolve(result);
            };
            internal.reject = (err) => {
                clearTimeout(timer);
                this.pendingInternal = null;
                reject(err);
            };
            this.pendingInternal = internal;
            this.writeToStdin(shellCmd).catch(internal.reject);
        });
    }

    /**
     * Build the guest-side ext4-overlay bootstrap. The second virtio block
     * device (`/dev/vdb`) is formatted ext4 on first boot and then used as the
     * overlay upperdir/workdir. The marker is emitted by the post-pivot/chroot
     * shell because `exec` replaces the shell before the normal marker runs.
     * @param {string} marker
     * @private
     */
    _overlayBootstrapScript(marker) {
        const lines = [
            'vdb=$(awk \'$4=="vdb"{print $1":"$2}\' /proc/partitions)',
            'if [ -n "$vdb" ]; then',
            '  major=${vdb%%:*}; minor=${vdb##*:}',
            '  mknod /dev/vdb b "$major" "$minor" 2>/dev/null',
            'fi',
            'mkdir -p /mnt/persist /newroot/dev /newroot/proc /newroot/sys /newroot/run',
            'magic=$(dd if=/dev/vdb bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d " \\n")',
            'if [ "$magic" != "53ef" ]; then',
            '  mkfs.ext4 -q /dev/vdb',
            'fi',
            'mount -t ext4 /dev/vdb /mnt/persist',
            'mkdir -p /mnt/persist/upper /mnt/persist/work',
            'mount -t overlay overlay -o lowerdir=/,upperdir=/mnt/persist/upper,workdir=/mnt/persist/work /newroot',
        ];
        if (this.mounts['/workspace']) {
            lines.push('mkdir -p /newroot/workspace');
            lines.push('mount --bind /workspace /newroot/workspace 2>/dev/null || true');
        }
        lines.push(
            'mount --bind /dev /newroot/dev 2>/dev/null || true',
            'mount --bind /proc /newroot/proc 2>/dev/null || true',
            'mount --bind /sys /newroot/sys 2>/dev/null || true',
            'mount --bind /run /newroot/run 2>/dev/null || true',
            'cd /newroot',
            'mkdir -p .oldroot',
            'if pivot_root . .oldroot 2>/dev/null; then',
            `  exec /bin/sh -c 'printf "${marker}\\n"; cd /; exec /bin/sh'`,
            'else',
            `  exec chroot . /bin/sh -c 'printf "${marker}\\n"; cd /; exec /bin/sh'`,
            'fi',
        );
        return lines.join('\n');
    }

    /**
     * Run a shell bootstrap that replaces the shell via exec. Resolves when the
     * marker is printed by the new shell.
     * @param {string} script
     * @param {string} marker
     * @param {number} timeoutMs
     * @private
     */
    _execBootstrap(script, marker, timeoutMs = 120000) {
        return new Promise((resolve, reject) => {
            const bootstrap = {
                marker,
                stdoutStr: '',
                stderrStr: '',
                resolve: null,
                reject: null,
            };
            const timer = setTimeout(() => {
                if (this.pendingBootstrap === bootstrap) {
                    this.pendingBootstrap = null;
                    reject(new Error('persistent root bootstrap timed out'));
                }
            }, timeoutMs);
            bootstrap.resolve = (result) => {
                clearTimeout(timer);
                this.pendingBootstrap = null;
                resolve(result);
            };
            bootstrap.reject = (err) => {
                clearTimeout(timer);
                this.pendingBootstrap = null;
                reject(err);
            };
            this.pendingBootstrap = bootstrap;
            this.writeToStdin(`${script}\n`).catch(bootstrap.reject);
        });
    }

    /**
     * Mount the persistent ext4 overlay upperdir and switch the shell root.
     * @private
     */
    async _mountPersistentRoot() {
        if (!this.isReady) throw new Error('VM not ready');
        if (!this.persistentRootGuestDir) throw new Error('persistentRoot is not enabled');
        const marker = `__AGENTVM_OVERLAY_DONE:${randomUUID()}`;
        return this._execBootstrap(this._overlayBootstrapScript(marker), marker, 120000);
    }

    /**
     * Fallback: snapshot the guest root to the workspace as a tar archive. Not
     * used by the default ext4-overlay path; kept for callers that want a
     * portable backup.
     * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
     */
    async snapshotRoot() {
        if (!this.isReady) throw new Error('VM not ready');
        if (!this.persistentRootGuestDir) throw new Error('persistentRoot is not enabled');
        const dir = this.persistentRootGuestDir;
        return this._execInternal(`mkdir -p ${dir}; tar cf ${dir}/root.tar / --exclude=workspace --exclude=proc --exclude=sys --exclude=dev --exclude=run --exclude=newroot 2>/dev/null`, 300000);
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

    async stop(options = {}) {
        // Flush the ext4/overlay page cache before terminating the worker so
        // writes reach the backing block device.
        if (this.persistentRoot && this.isReady && this.worker && !this.destroyed) {
            try {
                await this._execInternal('sync', 30000);
            } catch (err) {
                console.warn('[AgentVM] persistent root sync failed:', err.message);
            }
        }

        this.destroyed = true;
        
        // Close all port-forward listeners
        for (const forward of this.portForwards.values()) {
            if (forward.server) {
                try { forward.server.close(); } catch (e) {}
            }
        }
        this.portForwards.clear();

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
            this._releaseTcpSession(session);
        }
        this.tcpSessions.clear();
        
        if (this.ringFlushTimer) {
            clearTimeout(this.ringFlushTimer);
            this.ringFlushTimer = null;
        }
        if (this.networkRateTimer) {
            clearTimeout(this.networkRateTimer);
            this.networkRateTimer = null;
        }
        this.pendingRingEvents.length = 0;

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
    
    /** Queue a small control/datagram event until the SPSC ring has room. */
    _enqueueRingEvent(write, onWritten = null) {
        if (this.destroyed) return;
        this.pendingRingEvents.push({ write, onWritten });
        this._flushRingEvents();
    }

    _flushRingEvents() {
        if (this.destroyed) return;
        while (this.pendingRingEvents.length > 0) {
            const event = this.pendingRingEvents[0];
            if (!event.write()) break;
            this.pendingRingEvents.shift();
            if (event.onWritten) event.onWritten();
        }
        if (this.pendingRingEvents.length > 0 && !this.ringFlushTimer) {
            this.ringWriter.signalWorker();
            this.ringFlushTimer = setTimeout(() => {
                this.ringFlushTimer = null;
                this._flushRingEvents();
            }, 2);
        }
    }

    _handleTcpFlowControl(key, pause) {
        const session = this.tcpSessions.get(key);
        if (!session) return;
        session.flowPaused = pause;
        if (pause) session.socket.pause();
        else if (!session.rateLimitPaused && !session.ringBufferPaused && !session.connectAnnouncementPending) {
            session.socket.resume();
        }
    }

    _accountNetworkBytes(bytes) {
        if (this.networkRateLimit <= 0) return;
        // The global NIC queue bound in the worker prevents buffer bloat, so
        // a single connection does not need the aggregate throttle. Only slow
        // down when many flows are competing, which is exactly the npm case
        // that used to starve TLS handshakes and DNS.
        if (this.tcpSessions.size <= 2) return;
        const now = Date.now();
        if (now - this.networkWindowStarted >= 1000) {
            this.networkWindowStarted = now;
            this.networkBytesThisWindow = 0;
        }
        this.networkBytesThisWindow += bytes;
        if (this.networkBytesThisWindow < this.networkRateLimit || this.networkRateLimited) return;

        // The configured limit applies to the VM as a whole, not independently
        // to every npm connection. Per-socket limiting allowed dozens of
        // concurrent downloads to overwhelm TinyEMU by an order of magnitude.
        this.networkRateLimited = true;
        for (const session of this.tcpSessions.values()) {
            session.rateLimitPaused = true;
            session.socket.pause();
        }
        const delay = Math.max(1, 1000 - (now - this.networkWindowStarted));
        this.networkRateTimer = setTimeout(() => {
            this.networkRateTimer = null;
            this.networkRateLimited = false;
            this.networkWindowStarted = Date.now();
            this.networkBytesThisWindow = 0;
            for (const session of this.tcpSessions.values()) {
                session.rateLimitPaused = false;
                if (!session.ringBufferPaused && !session.flowPaused && !session.connectAnnouncementPending) {
                    session.socket.resume();
                }
            }
        }, delay);
    }

    /**
     * Handle a DNS lookup request from the worker. Resolution runs on the main
     * thread because worker threads must not call the async DNS resolver.
     * @private
     */
    async _handleDnsLookup(msg) {
        const { key, name, qtype } = msg;
        if (!this.networkEnabled) return;

        // DNS is an outbound UDP flow to port 53. Matching by hostname here is
        // nearly free because the query name is already parsed by the worker.
        const action = await this._evaluateFirewall('out', 'udp', null, 53, name);
        if (action === 'deny') {
            this._enqueueRingEvent(() => this.ringWriter.writeDnsResult({ key, name, qtype, error: 'blocked by firewall' }));
            return;
        }

        try {
            const family = qtype === 28 ? 6 : (qtype === 1 ? 4 : 0);
            const options = family === 0 ? { all: true, verbatim: true } : { all: true, family, verbatim: true };
            const results = await dns.promises.lookup(name, options);
            const ips = results.map((r) => r.address);
            // Lookups already in flight when networking is disabled are ignored.
            if (!this.networkEnabled) return;
            this._enqueueRingEvent(() => this.ringWriter.writeDnsResult({ key, name, qtype, ips }));
        } catch (err) {
            if (!this.networkEnabled) return;
            this._enqueueRingEvent(() => this.ringWriter.writeDnsResult({ key, name, qtype, error: err.message }));
        }
    }

    /**
     * Close an idle UDP session on the main thread.
     * @private
     */
    _handleUdpClose(msg) {
        const session = this.udpSessions.get(msg.key);
        if (session) {
            try { session.socket.close(); } catch (e) {}
            this.udpSessions.delete(msg.key);
        }
    }

    /**
     * Handle UDP send request from worker
     * @private
     */
    _handleUdpSend(msg) {
        const { key, dstIP, dstPort, payload, srcIP, srcPort } = msg;
        if (!this.networkEnabled) return;
        if (this._matchFirewallSync('out', 'udp', dstIP, dstPort, null) === 'deny') return;
        
        if (this.debug) {
            console.log(`[UDP] Send request: ${srcIP}:${srcPort} -> ${dstIP}:${dstPort}, ${payload.length} bytes`);
        }
        
        let session = this.udpSessions.get(key);
        if (!session) {
            const socket = dgram.createSocket('udp4');
            session = { socket, lastActive: Date.now(), srcIP, srcPort, dstIP, dstPort };
            this.udpSessions.set(key, session);
            
            socket.on('message', (data, rinfo) => {
                const expectedIP = dstIP === '192.168.127.1' ? '127.0.0.1' : dstIP;
                if (rinfo.port !== dstPort || (rinfo.address !== expectedIP && rinfo.address !== `::ffff:${expectedIP}`)) {
                    return;
                }
                if (this.debug) {
                    console.log(`[UDP] Response from ${rinfo.address}:${rinfo.port}, ${data.length} bytes`);
                }
                this._enqueueRingEvent(() => this.ringWriter.writeUdpRecv({ key, data }));
            });
            
            socket.on('error', (err) => {
                if (this.debug) console.error(`UDP socket error for ${key}:`, err.message);
                this.udpSessions.delete(key);
                try { socket.close(); } catch (e) {}
            });
        }
        
        session.lastActive = Date.now();
        const payloadBuf = Buffer.from(payload);
        const sendIP = dstIP === '192.168.127.1' ? '127.0.0.1' : dstIP;
        session.socket.send(payloadBuf, dstPort, sendIP);
    }
    
    /**
     * Handle TCP connect request from worker
     * @private
     */
    async _handleTcpConnect(msg) {
        const { key, dstIP, dstPort, srcIP, srcPort } = msg;
        if (!this.networkEnabled) return;

        // A duplicate SYN must never create a second host socket for the same
        // guest flow, including while a firewall hostname rule is resolving.
        if (this.pendingTcpConnects.has(key)) return;
        const existing = this.tcpSessions.get(key);
        if (existing) {
            if (!existing.socket.destroyed) return;
            this._releaseTcpSession(existing);
            this.tcpSessions.delete(key);
        }

        this.pendingTcpConnects.add(key);
        try {
            const action = await this._evaluateFirewall('out', 'tcp', dstIP, dstPort, null);
            if (action === 'deny') {
                this._enqueueRingEvent(() => this.ringWriter.writeTcpError(key, 'blocked by firewall'));
                return;
            }
            if (!this.networkEnabled) return;
            this._openTcpConnect(key, dstIP, dstPort, srcIP, srcPort);
        } catch (err) {
            this._enqueueRingEvent(() => this.ringWriter.writeTcpError(key, err.message));
        } finally {
            this.pendingTcpConnects.delete(key);
        }
    }

    /**
     * Open the host socket for an outbound guest TCP flow.
     * @private
     */
    _openTcpConnect(key, dstIP, dstPort, srcIP, srcPort) {
        // Translate gateway IP to localhost for local server access
        const connectIP = (dstIP === GATEWAY_IP) ? '127.0.0.1' : dstIP;

        const socket = new net.Socket();
        
        // Enable TCP keepalive to prevent connection drops during pauses
        socket.setKeepAlive(true, 30000); // Send keepalive every 30 seconds
        
        // Set a generous timeout for slow connections (5 minutes)
        socket.setTimeout(300000);
        
        const session = { 
            socket, srcIP, srcPort, dstIP, dstPort,
            rateLimitPaused: this.networkRateLimited,
            ringBufferPaused: false,
            flowPaused: false,
            connectAnnouncementPending: true,
            pendingResume: null
        };
        this.tcpSessions.set(key, session);
        this._wireTcpSocket(key, socket, session);
        
        if (this.debug) {
            console.log(`[TCP] Connecting to ${connectIP}:${dstPort}, key=${key}`);
        }
        
        socket.connect(dstPort, connectIP, () => {
            // Do not allow host data to overtake the connected event if the
            // ring happens to be full.
            socket.pause();
            this._enqueueRingEvent(
                () => this.ringWriter.writeTcpConnected(key),
                () => {
                    session.connectAnnouncementPending = false;
                    if (!session.rateLimitPaused && !session.ringBufferPaused && !session.flowPaused) socket.resume();
                }
            );
        });
    }

    /**
     * Attach the shared host-socket -> worker-ring pipeline for a TCP session.
     * Both outbound and port-forwarded (inbound) flows reuse this; only the
     * initiation direction differs.
     * @private
     */
    _wireTcpSocket(key, socket, session) {
        socket.on('data', (data) => {
            if (this.debug) {
                console.log(`[TCP] Received ${data.length} bytes from server for ${key}`);
            }
            this._accountNetworkBytes(data.length);
            
            // Send data to worker via ring buffer
            const bytesWritten = this.ringWriter.writeTcpData(key, data);
            
            if (bytesWritten < data.length) {
                // Not all data was written - buffer the remainder and pause socket
                const remaining = data.slice(bytesWritten);
                if (!session.pendingData) {
                    session.pendingData = [];
                }
                session.pendingData.push(remaining);
                
                // Signal worker to drain the buffer
                this.ringWriter.signalWorker();
                
                if (!session.ringBufferPaused) {
                    session.ringBufferPaused = true;
                    socket.pause();
                    if (this.debug) {
                        console.log(`[RingBuffer] Pausing ${key}, wrote ${bytesWritten}/${data.length}, ${session.pendingData.length} chunks pending`);
                    }
                    
                    // Try to flush pending data periodically
                    this._scheduleRingBufferFlush(key);
                }
            }
        });
        
        socket.on('end', () => {
            // Mark that we've received FIN from remote
            session.remoteEnded = true;
            
            // If socket is paused for ring buffer backpressure, defer the END
            // This ensures all data arrives at the worker before the END
            if (session.ringBufferPaused || (session.pendingData && session.pendingData.length > 0)) {
                if (this.debug) {
                    console.log(`[TCP] Deferring END for ${key}, paused=${session.ringBufferPaused}, pending=${session.pendingData?.length || 0}`);
                }
                // The flush timer will send the END once pending data is flushed
            } else {
                if (this.debug) {
                    console.log(`[TCP] Sending END for ${key} immediately`);
                }
                session.endSent = true;
                this._enqueueRingEvent(() => this.ringWriter.writeTcpEnd(key));
            }
        });
        
        socket.on('close', () => {
            if (this.tcpSessions.get(key) !== session) return;
            if (session.pendingResume) {
                clearTimeout(session.pendingResume);
                session.pendingResume = null;
            }
            session.socketClosed = true;

            // An orderly close follows `end`. Keep the session and its flush
            // timer alive until all previously received bytes and END have
            // entered the worker ring. Otherwise the tail of large downloads
            // is silently discarded.
            if (session.remoteEnded) {
                if (!session.pendingData || session.pendingData.length === 0) {
                    if (!session.endSent) {
                        session.endSent = true;
                        this._enqueueRingEvent(() => this.ringWriter.writeTcpEnd(key));
                    }
                    this._releaseTcpSession(session);
                    this.tcpSessions.delete(key);
                }
                return;
            }

            if (session.ringBufferFlushTimer) {
                clearInterval(session.ringBufferFlushTimer);
                session.ringBufferFlushTimer = null;
            }
            this._enqueueRingEvent(() => this.ringWriter.writeTcpClose(key));
            this._releaseTcpSession(session);
            this.tcpSessions.delete(key);
        });
        
        socket.on('error', (err) => {
            // Clean up timers
            if (session.pendingResume) {
                clearTimeout(session.pendingResume);
                session.pendingResume = null;
            }
            if (session.ringBufferFlushTimer) {
                clearInterval(session.ringBufferFlushTimer);
                session.ringBufferFlushTimer = null;
            }
            this._enqueueRingEvent(() => this.ringWriter.writeTcpError(key, err.message));
            this._releaseTcpSession(session);
            this.tcpSessions.delete(key);
        });
        
        socket.on('timeout', () => {
            // Socket has been idle too long - just reset the timeout, don't close
            // This handles the case where the VM is slow to process data
            if (this.debug) {
                console.log(`[TCP] Socket timeout for ${key}, resetting`);
            }
            // Reset the timeout - we don't want to close the connection
            socket.setTimeout(300000);
        });
    }
    
    /**
     * Release resources tied to a TCP session's key (currently just inbound
     * ephemeral ports). Call before removing a session from `tcpSessions`.
     * @private
     */
    _releaseTcpSession(session) {
        if (session && session.incoming) {
            this.usedIncomingPorts.delete(session.incomingPort);
        }
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
     * Validate and normalize a port-forward configuration.
     * @private
     */
    _validatePortForward(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Port forward config must be an object');
        }
        const hostPort = Number(config.hostPort);
        const guestPort = Number(config.guestPort);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
            throw new Error(`Invalid hostPort: ${config.hostPort}`);
        }
        if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
            throw new Error(`Invalid guestPort: ${config.guestPort}`);
        }
        const protocol = config.protocol || 'tcp';
        if (protocol !== 'tcp') {
            throw new Error('Only TCP port forwarding is supported in v1');
        }
        const rawGuestHost = config.guestHost || GUEST_IP;
        const guestOctets = String(rawGuestHost).split('.');
        if (guestOctets.length !== 4 || guestOctets.some((n) => !/^\d{1,3}$/.test(n) || Number(n) > 255)) {
            throw new Error(`Invalid guestHost: ${config.guestHost}`);
        }
        const guestHost = guestOctets.map(Number).join('.');
        const bind = config.bind || '127.0.0.1';
        if (bind !== '127.0.0.1' && bind !== '0.0.0.0') {
            throw new Error(`Invalid bind address: ${config.bind}`);
        }
        return { hostPort, guestPort, guestHost, protocol, bind };
    }

    /**
     * Add a live TCP port forward from a host loopback port to a guest port.
     * No VM restart is required; the listener is bound immediately.
     * @param {{hostPort: number, guestPort: number, guestHost?: string, protocol?: 'tcp', bind?: '127.0.0.1'|'0.0.0.0'}} config
     * @returns {Promise<Object>} the normalized forward
     */
    async addPortForward(config) {
        const forward = this._validatePortForward(config);
        if (this.portForwards.has(forward.hostPort)) {
            throw new Error(`Port forward already exists for host port ${forward.hostPort}`);
        }

        const server = net.createServer((socket) => this._handleIncomingTcp(socket, forward));
        server.on('error', (err) => {
            if (this.debug) {
                console.error(`[PortForward] ${forward.hostPort}: ${err.message}`);
            }
        });

        await new Promise((resolve, reject) => {
            const onError = (err) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(forward.hostPort, forward.bind);
        });

        forward.server = server;
        this.portForwards.set(forward.hostPort, forward);
        return forward;
    }

    /**
     * Remove a port forward and tear down its active flows.
     * @param {number} hostPort
     * @returns {boolean} true when a forward was removed
     */
    removePortForward(hostPort) {
        const forward = this.portForwards.get(hostPort);
        if (!forward) return false;

        if (forward.server) {
            try { forward.server.close(); } catch (e) {}
        }
        this.portForwards.delete(hostPort);

        for (const [key, session] of [...this.tcpSessions]) {
            if (session.forward !== forward) continue;
            try { session.socket.destroy(); } catch (e) {}
            this._enqueueRingEvent(() => this.ringWriter.writeTcpError(key, 'port forward removed'));
            this._releaseTcpSession(session);
            this.tcpSessions.delete(key);
        }
        return true;
    }

    /**
     * List current port forwards (without the internal server handles).
     * @returns {Array<Object>}
     */
    listPortForwards() {
        return [...this.portForwards.values()].map(({ hostPort, guestPort, guestHost, protocol, bind }) => ({
            hostPort, guestPort, guestHost, protocol, bind,
        }));
    }

    /**
     * Normalize a Node socket remote address for firewall matching.
     * @private
     */
    _normalizeRemoteAddress(address) {
        return String(address || '').replace(/^::ffff:/, '');
    }

    /**
     * Allocate an ephemeral source port for an inbound (port-forwarded) flow.
     * @private
     */
    _allocateIncomingPort() {
        for (let i = 0; i < 20000; i++) {
            const port = 40000 + ((this.nextIncomingPort - 40000 + i) % 20000);
            if (!this.usedIncomingPorts.has(port)) {
                this.usedIncomingPorts.add(port);
                this.nextIncomingPort = 40000 + ((port - 40000 + 1) % 20000);
                return port;
            }
        }
        throw new Error('No ephemeral ports available for port forwarding');
    }

    /**
     * Handle a host connection accepted by a port-forward listener. This is
     * the mirror image of `_openTcpConnect`: instead of connecting a host
     * socket after a guest SYN, we accept a host socket and ask the worker to
     * perform an active TCP open toward the guest.
     * @private
     */
    async _handleIncomingTcp(socket, forward) {
        socket.pause();
        socket.setKeepAlive(true, 30000);
        socket.setTimeout(300000);

        if (!this.isReady || this.destroyed || !this.networkEnabled) {
            socket.destroy();
            return;
        }

        const clientIP = this._normalizeRemoteAddress(socket.remoteAddress);
        try {
            const action = await this._evaluateFirewall('in', 'tcp', clientIP, forward.hostPort, null);
            if (action === 'deny' || !this.networkEnabled || this.destroyed) {
                socket.destroy();
                return;
            }
        } catch (err) {
            socket.destroy();
            return;
        }

        let incomingPort;
        try {
            incomingPort = this._allocateIncomingPort();
        } catch (err) {
            socket.destroy();
            return;
        }

        // The worker computes flow keys from the guest's packet direction, so
        // this key is `guest -> gateway` just like an outbound flow. The main
        // thread and worker must agree on this exact string for data routing.
        const key = `TCP:${forward.guestHost}:${forward.guestPort}:${GATEWAY_IP}:${incomingPort}`;
        const session = {
            socket,
            srcIP: forward.guestHost,
            srcPort: forward.guestPort,
            dstIP: GATEWAY_IP,
            dstPort: incomingPort,
            incoming: true,
            incomingPort,
            forward,
            rateLimitPaused: this.networkRateLimited,
            ringBufferPaused: false,
            flowPaused: false,
            connectAnnouncementPending: false,
            pendingResume: null,
        };
        this.tcpSessions.set(key, session);
        this._wireTcpSocket(key, socket, session);

        // The incoming-connect message must enter the ring before any host
        // bytes are read, so the worker creates the guest flow first. Resume
        // the socket only after the message is actually written.
        this._enqueueRingEvent(
            () => this.ringWriter.writeTcpIncomingConnect({
                key,
                guestHost: forward.guestHost,
                guestPort: forward.guestPort,
                srcPort: incomingPort,
            }),
            () => socket.resume(),
        );
    }

    /**
     * Schedule flushing of pending ring buffer data
     * @private
     */
    _scheduleRingBufferFlush(key) {
        const session = this.tcpSessions.get(key);
        if (!session || session.ringBufferFlushTimer) return;
        
        // Use a short interval to continuously try flushing
        session.ringBufferFlushTimer = setInterval(() => {
            if (!session.pendingData || session.pendingData.length === 0) {
                // Nothing to flush - clear timer and resume
                clearInterval(session.ringBufferFlushTimer);
                session.ringBufferFlushTimer = null;
                session.ringBufferPaused = false;
                
                if (!session.rateLimitPaused && !session.flowPaused && !session.connectAnnouncementPending && session.socket) {
                    session.socket.resume();
                    if (this.debug) {
                        console.log(`[RingBuffer] Resuming ${key}, buffer drained`);
                    }
                }
                return;
            }
            
            // Try to write pending chunks
            let written = 0;
            while (session.pendingData.length > 0) {
                const chunk = session.pendingData[0];
                const bytesWritten = this.ringWriter.writeTcpData(key, chunk);
                
                if (bytesWritten === chunk.length) {
                    // Full chunk written
                    session.pendingData.shift();
                    written += chunk.length;
                } else if (bytesWritten > 0) {
                    // Partial write - keep the remainder
                    session.pendingData[0] = chunk.slice(bytesWritten);
                    written += bytesWritten;
                    // Buffer is full - signal worker to drain it
                    this.ringWriter.signalWorker();
                    break;
                } else {
                    // No space at all - signal worker to drain it
                    this.ringWriter.signalWorker();
                    break;
                }
            }
            
            if (this.debug && written > 0) {
                console.log(`[RingBuffer] Flushed ${written} bytes for ${key}, ${session.pendingData.length} chunks remaining`);
            }
            
            // If all pending data flushed, clear timer and resume
            if (session.pendingData.length === 0) {
                // Send deferred END if remote ended while we had pending data
                // Important: We must ensure END is written before clearing the timer
                if (session.remoteEnded && !session.endSent) {
                    const endWritten = this.ringWriter.writeTcpEnd(key);
                    if (!endWritten) {
                        // No space for END yet - signal worker and try again next tick
                        this.ringWriter.signalWorker();
                        if (this.debug) {
                            console.log(`[RingBuffer] Waiting to send END for ${key}, buffer full`);
                        }
                        return; // Don't clear timer yet, keep trying
                    }
                    session.endSent = true;
                    if (this.debug) {
                        console.log(`[RingBuffer] Sent deferred END for ${key}`);
                    }
                }
                if (session.socketClosed) {
                    this._releaseTcpSession(session);
                    this.tcpSessions.delete(key);
                }
                
                clearInterval(session.ringBufferFlushTimer);
                session.ringBufferFlushTimer = null;
                session.ringBufferPaused = false;
                
                if (!session.rateLimitPaused && !session.flowPaused && !session.connectAnnouncementPending && session.socket) {
                    session.socket.resume();
                    if (this.debug) {
                        console.log(`[RingBuffer] Resuming ${key}, pending data flushed`);
                    }
                }
            }
        }, 1); // Try every 1ms
    }
    
    // Note: Worker-side flow control (tcp-pause) removed - using ring buffer backpressure only
    
    // Note: Worker-side flow control (tcp-resume) removed - using ring buffer backpressure only

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
        const CHUNK_SIZE = STDIN_AREA_SIZE;

        while (offset < encoded.length) {
            // Wait for buffer to be free (0)
            // We use a polling loop to avoid blocking the main thread event loop
            while (Atomics.load(this.int32, STDIN_FLAG_INDEX) !== 0) {
                await new Promise(r => setTimeout(r, 5));
            }

            const chunk = encoded.subarray(offset, offset + CHUNK_SIZE);
            this.ringWriter.writeStdin(chunk);
            
            offset += chunk.length;
        }
    }

    handleOutput(type, dataUint8) {
        const text = new TextDecoder().decode(dataUint8); // Assuming UTF-8 valid chunks
        
        // Debug
        // console.log(`[VM ${type}]`, JSON.stringify(text));

        // A pivot/chroot bootstrap replaces the shell, so its marker is
        // emitted by the new shell rather than by an appended printf.
        if (this.pendingBootstrap) {
            const bootstrap = this.pendingBootstrap;
            if (type === 'stdout') {
                bootstrap.stdoutStr += text;
                if (bootstrap.stdoutStr.includes(bootstrap.marker)) {
                    bootstrap.resolve(true);
                }
            } else {
                bootstrap.stderrStr += text;
            }
            return;
        }

        // Internal commands run in both exec and interactive modes, so
        // capture them before interactive output routing.
        if (this.pendingInternal) {
            const internal = this.pendingInternal;
            if (type === 'stdout') {
                internal.stdoutStr += text;
                const markerIdx = internal.stdoutStr.indexOf(internal.marker);
                if (markerIdx !== -1) {
                    const rest = internal.stdoutStr.substring(markerIdx);
                    const parts = rest.trim().split(':');
                    const exitCode = parseInt(parts[parts.length - 1], 10);
                    internal.resolve({
                        stdout: internal.stdoutStr.substring(0, markerIdx).trim(),
                        stderr: internal.stderrStr,
                        exitCode: isNaN(exitCode) ? 0 : exitCode,
                    });
                }
            } else {
                internal.stderrStr += text;
            }
            return;
        }

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

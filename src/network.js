const EventEmitter = require('events');
const {
    RingBufferReader,
    NET_MSG_TCP_CONNECTED,
    NET_MSG_TCP_DATA,
    NET_MSG_TCP_END,
    NET_MSG_TCP_ERROR,
    NET_MSG_TCP_CLOSE,
    NET_MSG_UDP_RECV,
    NET_MSG_DNS_RESULT,
} = require('./ringbuffer');

// Protocol constants
const ETH_P_IP = 0x0800;
const ETH_P_ARP = 0x0806;
const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const IP_PROTO_ICMP = 1;

// TCP flags
const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;

const MSS = 1460; // 1500 - 20 IP - 20 TCP
const INITIAL_WINDOW = 65535;

// Timing (milliseconds)
const TCP_RETRANSMIT_MS = 1000;
const TCP_MAX_RETRANSMITS = 6;
const TCP_IDLE_REAP_MS = 120000;
const UDP_IDLE_REAP_MS = 30000;

// DHCP constants
const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const DHCP_MAGIC_COOKIE = 0x63825363;
const DHCP_DISCOVER = 1;
const DHCP_OFFER = 2;
const DHCP_REQUEST = 3;
const DHCP_ACK = 5;
const DHCP_OPT_SUBNET_MASK = 1;
const DHCP_OPT_ROUTER = 3;
const DHCP_OPT_DNS = 6;
const DHCP_OPT_LEASE_TIME = 51;
const DHCP_OPT_MSG_TYPE = 53;
const DHCP_OPT_SERVER_ID = 54;
const DHCP_OPT_END = 255;

function ipToString(buf) {
    return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function ipToBuf(str) {
    return Buffer.from(String(str).split('.').map(Number));
}

function wrap32(x) {
    return x >>> 0;
}

// Sequence-number comparisons (mod 2^32).
const seqLt = (a, b) => (((a - b) | 0) < 0);
const seqLeq = (a, b) => (((a - b) | 0) <= 0);
const seqGt = (a, b) => (((a - b) | 0) > 0);
const seqGeq = (a, b) => (((a - b) | 0) >= 0);

class NetworkStack extends EventEmitter {
    constructor(options = {}) {
        super();
        this.gatewayIP = options.gatewayIP || '192.168.127.1';
        this.vmIP = options.vmIP || '192.168.127.3';
        this.gatewayMac = options.gatewayMac || Buffer.from([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
        this.vmMac = options.vmMac ? Buffer.from(options.vmMac) : Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

        this.ringReader = options.ringReader || null;
        this.netPort = options.netPort || null;

        // Frames queued to the VM (QEMU-framed Ethernet). This is the only
        // thing the emulator socket delivers to the guest NIC.
        this.txBuffer = Buffer.alloc(0);
        // Bytes received from the VM, reassembled into complete frames.
        this.rxBuffer = Buffer.alloc(0);

        this.tcpFlows = new Map();
        this.udpFlows = new Map();
        this.pendingDns = new Map(); // key -> { srcIp, srcPort, id, name, qtype }
        this._lastTick = Date.now();
    }

    /* ------------------------------------------------------------------ *
     * Frame pipe (worker <-> emulator socket)
     * ------------------------------------------------------------------ */

    hasNetworkData() {
        return this.ringReader && this.ringReader.hasNetworkData();
    }

    writeToNetwork(data) {
        if (!data || data.length === 0) return;
        this.rxBuffer = this.rxBuffer.length === 0
            ? Buffer.from(data)
            : Buffer.concat([this.rxBuffer, data]);

        while (this.rxBuffer.length >= 4) {
            const frameLen = this.rxBuffer.readUInt32BE(0);
            if (this.rxBuffer.length < 4 + frameLen) break;
            const frame = this.rxBuffer.subarray(4, 4 + frameLen);
            this.rxBuffer = this.rxBuffer.subarray(4 + frameLen);
            try {
                this.receive(frame);
            } catch (err) {
                this.emit('error', err);
            }
        }

        // Safety: never let a malformed frame grow the reassembly buffer
        // without bound.
        if (this.rxBuffer.length > 1024 * 1024) {
            this.rxBuffer = Buffer.alloc(0);
        }
    }

    readFromNetwork(maxLen) {
        if (this.txBuffer.length === 0) return null;
        const chunk = this.txBuffer.subarray(0, maxLen);
        this.txBuffer = this.txBuffer.subarray(chunk.length);
        return chunk;
    }

    hasPendingData() {
        return this.txBuffer.length > 0;
    }

    pendingDataSize() {
        return this.txBuffer.length;
    }

    /**
     * Close every flow. Called when the emulator socket itself is closed.
     * Per-connection FIN/RST is handled inside handleTCP / tick, not here.
     */
    closeSocket() {
        for (const [key, flow] of this.tcpFlows) {
            this._destroyHost(key, true);
        }
        this.tcpFlows.clear();
        for (const [key] of this.udpFlows) {
            this._post({ type: 'udp-close', key });
        }
        this.udpFlows.clear();
    }

    /* ------------------------------------------------------------------ *
     * Ring buffer <-> main thread event pump
     * ------------------------------------------------------------------ */

    pollNetResponses() {
        if (!this.ringReader) return;

        let msg;
        let read = 0;
        while ((msg = this.ringReader.readNetworkMessage())) {
            read++;
            switch (msg.type) {
                case NET_MSG_UDP_RECV: {
                    const p = this.ringReader.parseUdpRecv(msg.payload);
                    this._handleUdpResponse(p);
                    break;
                }
                case NET_MSG_DNS_RESULT: {
                    const p = this.ringReader.parseDnsResult(msg.payload);
                    this._handleDnsResult(p);
                    break;
                }
                case NET_MSG_TCP_CONNECTED: {
                    const key = this.ringReader.parseKey(msg.payload);
                    this._handleTcpConnected(key);
                    break;
                }
                case NET_MSG_TCP_DATA: {
                    const p = this.ringReader.parseTcpData(msg.payload);
                    this._handleTcpData(p);
                    break;
                }
                case NET_MSG_TCP_END: {
                    const key = this.ringReader.parseKey(msg.payload);
                    this._handleTcpEnd(key);
                    break;
                }
                case NET_MSG_TCP_ERROR: {
                    const p = this.ringReader.parseTcpError(msg.payload);
                    this._handleTcpError(p);
                    break;
                }
                case NET_MSG_TCP_CLOSE: {
                    const key = this.ringReader.parseKey(msg.payload);
                    this._handleTcpClosed(key);
                    break;
                }
            }
        }
        if (read) this.emit('network-activity');
    }

    /**
     * Drive retransmission and idle reaping. Called periodically by the
     * worker's poll_oneoff loop so we make progress even when the guest is
     * blocked waiting for network data.
     */
    tick() {
        const now = Date.now();
        for (const [, flow] of this.tcpFlows) {
            this._retransmit(flow, now);
            if (now - flow.lastActivity > TCP_IDLE_REAP_MS) {
                this._destroyHost(flow.key, true);
                this.tcpFlows.delete(flow.key);
            }
        }
        for (const [key, flow] of this.udpFlows) {
            if (now - flow.lastActivity > UDP_IDLE_REAP_MS) {
                this._post({ type: 'udp-close', key });
                this.udpFlows.delete(key);
            }
        }
        this._lastTick = now;
    }

    _post(msg) {
        if (this.netPort) this.netPort.postMessage(msg);
    }

    _destroyHost(key, destroy) {
        this._post({ type: 'tcp-close', key, destroy });
    }

    /* ------------------------------------------------------------------ *
     * Ethernet / ARP / IP / ICMP
     * ------------------------------------------------------------------ */

    send(payload, proto) {
        if (!this.vmMac) return;
        const frame = Buffer.alloc(14 + payload.length);
        this.vmMac.copy(frame, 0);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(proto, 12);
        payload.copy(frame, 14);

        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        this.emit('tx', frame);
        this.emit('network-activity');
    }

    sendBroadcast(payload, proto) {
        const broadcastMac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        const frame = Buffer.alloc(14 + payload.length);
        broadcastMac.copy(frame, 0);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(proto, 12);
        payload.copy(frame, 14);

        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        this.emit('network-activity');
    }

    receive(frame) {
        if (frame.length < 14) return;
        const etherType = frame.readUInt16BE(12);
        const payload = frame.subarray(14);

        const srcMac = frame.subarray(6, 12);
        if (!this.vmMac) this.vmMac = Buffer.from(srcMac);

        if (etherType === ETH_P_ARP) this.handleARP(payload);
        else if (etherType === ETH_P_IP) this.handleIP(payload);
    }

    handleARP(packet) {
        if (packet.readUInt16BE(6) !== 1) return; // only requests
        const targetIP = ipToString(packet.subarray(24, 28));
        if (targetIP !== this.gatewayIP) return;

        const reply = Buffer.alloc(28);
        packet.copy(reply, 0, 0, 8);
        reply.writeUInt16BE(2, 6);
        this.gatewayMac.copy(reply, 8);
        packet.subarray(24, 28).copy(reply, 14); // sender IP = target (gateway)
        packet.subarray(8, 14).copy(reply, 18); // target HW = requester
        packet.subarray(14, 18).copy(reply, 24); // target IP = requester
        this.send(reply, ETH_P_ARP);
    }

    handleIP(packet) {
        if ((packet[0] >> 4) !== 4) return;
        const headerLen = (packet[0] & 0x0f) * 4;
        const totalLen = packet.readUInt16BE(2);
        const protocol = packet[9];
        const srcIP = packet.subarray(12, 16);
        const dstIP = packet.subarray(16, 20);
        const data = packet.subarray(headerLen, totalLen);

        if (protocol === IP_PROTO_ICMP) this.handleICMP(data, srcIP, dstIP);
        else if (protocol === IP_PROTO_TCP) this.handleTCP(data, srcIP, dstIP);
        else if (protocol === IP_PROTO_UDP) this.handleUDP(data, srcIP, dstIP);
    }

    calculateChecksum(buf) {
        let sum = 0;
        for (let i = 0; i < buf.length - 1; i += 2) sum += buf.readUInt16BE(i);
        if (buf.length % 2 === 1) sum += buf[buf.length - 1] << 8;
        while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
        return (~sum) & 0xffff;
    }

    handleICMP(data, srcIP, dstIP) {
        if (data[0] !== 8) return; // echo request
        const reply = Buffer.from(data);
        reply[0] = 0; // echo reply
        reply[2] = 0; reply[3] = 0;
        reply.writeUInt16BE(this.calculateChecksum(reply), 2);
        this.sendIP(reply, IP_PROTO_ICMP, dstIP, srcIP);
    }

    sendIP(payload, protocol, srcIP, dstIP) {
        const header = Buffer.alloc(20);
        header[0] = 0x45;
        header[1] = 0;
        header.writeUInt16BE(20 + payload.length, 2);
        header.writeUInt16BE(0, 4);
        header.writeUInt16BE(0x4000, 6); // DF
        header[8] = 64;
        header[9] = protocol;
        srcIP.copy(header, 12);
        dstIP.copy(header, 16);
        header.writeUInt16BE(this.calculateChecksum(header), 10);

        const packet = Buffer.concat([header, payload]);
        const isBroadcast = dstIP[0] === 255 && dstIP[1] === 255 && dstIP[2] === 255 && dstIP[3] === 255;
        if (isBroadcast) this.sendBroadcast(packet, ETH_P_IP);
        else this.send(packet, ETH_P_IP);
    }

    /* ------------------------------------------------------------------ *
     * TCP (guest-facing endpoint + host net.Socket relay)
     * ------------------------------------------------------------------ */

    _tcpKey(srcIP, srcPort, dstIP, dstPort) {
        return `TCP:${ipToString(srcIP)}:${srcPort}:${ipToString(dstIP)}:${dstPort}`;
    }

    sendTCP(dstIP, dstPort, srcIP, srcPort, seq, ack, flags, payload = Buffer.alloc(0)) {
        const header = Buffer.alloc(20);
        header.writeUInt16BE(srcPort, 0);
        header.writeUInt16BE(dstPort, 2);
        header.writeUInt32BE(wrap32(seq), 4);
        header.writeUInt32BE(wrap32(ack), 8);
        header[12] = 0x50; // data offset = 5 words
        header[13] = flags;
        header.writeUInt16BE(INITIAL_WINDOW, 14);
        header.writeUInt16BE(0, 16);
        header.writeUInt16BE(0, 18);

        const pseudo = Buffer.alloc(12);
        srcIP.copy(pseudo, 0);
        dstIP.copy(pseudo, 4);
        pseudo[8] = 0;
        pseudo[9] = IP_PROTO_TCP;
        pseudo.writeUInt16BE(20 + payload.length, 10);

        header.writeUInt16BE(this.calculateChecksum(Buffer.concat([pseudo, header, payload])), 16);
        this.sendIP(Buffer.concat([header, payload]), IP_PROTO_TCP, srcIP, dstIP);
    }

    handleTCP(segment, srcIP, dstIP) {
        if (segment.length < 20) return;
        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const seq = segment.readUInt32BE(4);
        const ack = segment.readUInt32BE(8);
        const offset = (segment[12] >> 4) * 4;
        const flags = segment[13];
        const window = segment.readUInt16BE(14);
        const payload = segment.subarray(offset);

        const key = this._tcpKey(srcIP, srcPort, dstIP, dstPort);
        let flow = this.tcpFlows.get(key);

        if (flags & TCP_RST) {
            if (flow) {
                this._destroyHost(key, true);
                this.tcpFlows.delete(key);
            }
            return;
        }

        if ((flags & TCP_SYN) && !flow) {
            // Guest initiates a connection.
            flow = {
                key,
                srcIP: Buffer.from(srcIP),
                srcPort,
                dstIP: Buffer.from(dstIP),
                dstPort,
                state: 'SYN_SENT',
                guestSeq: wrap32(seq + 1),
                guestWindow: window || INITIAL_WINDOW,
                hostSeq: (Math.random() * 0x7fffffff) | 0,
                hostAcked: 0,
                pending: [],
                unacked: [],
                hostClosed: false,
                guestClosed: false,
                finSentToGuest: false,
                lastActivity: Date.now(),
                retransmits: 0,
            };
            this.tcpFlows.set(key, flow);
            this._post({
                type: 'tcp-connect',
                key,
                dstIP: ipToString(dstIP),
                dstPort,
                srcIP: ipToString(srcIP),
                srcPort,
            });
            return;
        }

        if (!flow) {
            // No session; only respond with RST to non-RST segments.
            if (!(flags & TCP_RST)) {
                this.sendTCP(srcIP, srcPort, dstIP, dstPort, 0, wrap32(seq + (payload.length || 1)), TCP_RST);
            }
            return;
        }

        flow.lastActivity = Date.now();

        // Acknowledge our data and honor the guest's advertised window.
        // A zero window must be honored exactly (0 || fallback would ignore it
        // and overrun the guest receive buffer).
        if (flags & TCP_ACK) {
            flow.guestWindow = window;
            this._purgeUnacked(flow, ack);
        }

        // Guest -> host payload.
        if (payload.length > 0) {
            if (flow.state !== 'SYN_SENT' && !flow.hostClosed) {
                this._post({ type: 'tcp-send', key, data: Array.from(payload) });
            }
            flow.guestSeq = wrap32(flow.guestSeq + payload.length);
            this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                         flow.hostSeq, flow.guestSeq, TCP_ACK);
        }

        if (flags & TCP_FIN) {
            flow.guestSeq = wrap32(flow.guestSeq + 1);
            flow.guestClosed = true;
            this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                         flow.hostSeq, flow.guestSeq, TCP_ACK);
            if (!flow.hostClosed) {
                this._post({ type: 'tcp-close', key, destroy: false }); // half-close host write side
            }
            // Deliver any remaining host data, then FIN/cleanup if fully done.
            this._maybeSend(flow);
            return;
        }

        this._maybeSend(flow);
    }

    _purgeUnacked(flow, ack) {
        while (flow.unacked.length > 0) {
            const e = flow.unacked[0];
            const end = wrap32(e.seq + e.data.length);
            if (seqLeq(end, ack)) {
                // Fully acknowledged.
                flow.unacked.shift();
                flow.hostAcked = end;
                flow.retransmits = 0;
                continue;
            }
            if (seqGt(ack, e.seq)) {
                // Partially acknowledged: trim the acked prefix.
                const acked = wrap32(ack - e.seq);
                e.data = e.data.subarray(acked);
                e.seq = ack;
                flow.hostAcked = ack;
            }
            break;
        }
    }

    _maybeSend(flow) {
        if (flow.state === 'SYN_SENT') return;
        let inFlight = 0;
        for (const e of flow.unacked) inFlight += e.data.length;

        while (flow.pending.length > 0 && inFlight < flow.guestWindow) {
            const data = flow.pending.shift();
            const seg = data.subarray(0, Math.min(MSS, data.length));
            const rest = data.subarray(seg.length);
            if (rest.length > 0) flow.pending.unshift(rest);

            const isLast = rest.length === 0;
            this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                         flow.hostSeq, flow.guestSeq, isLast ? (TCP_ACK | TCP_PSH) : TCP_ACK, seg);
            flow.unacked.push({ seq: flow.hostSeq, data: Buffer.from(seg), sentAt: Date.now() });
            flow.hostSeq = wrap32(flow.hostSeq + seg.length);
            inFlight += seg.length;
        }

        // Once all host data has been queued to the guest, send FIN if the
        // host side has closed. FIN is ordered after the data by sequence
        // number, so unacked-but-sent data is fine.
        if (flow.hostClosed && !flow.finSentToGuest && flow.pending.length === 0) {
            flow.finSentToGuest = true;
            this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                         flow.hostSeq, flow.guestSeq, TCP_FIN | TCP_ACK);
            flow.hostSeq = wrap32(flow.hostSeq + 1);
        }

        if (flow.hostClosed && flow.guestClosed && flow.pending.length === 0 && flow.unacked.length === 0) {
            this.tcpFlows.delete(flow.key);
        }
    }

    _retransmit(flow, now) {
        if (flow.unacked.length === 0) return;
        if (flow.retransmits >= TCP_MAX_RETRANSMITS) return;
        const e = flow.unacked[0];
        if (now - e.sentAt < TCP_RETRANSMIT_MS) return;

        e.sentAt = now;
        flow.retransmits++;
        this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                     e.seq, flow.guestSeq, TCP_ACK, e.data);
    }

    _handleTcpConnected(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow || flow.state !== 'SYN_SENT') return;
        flow.state = 'ESTABLISHED';
        flow.lastActivity = Date.now();
        this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                     flow.hostSeq, flow.guestSeq, TCP_SYN | TCP_ACK);
        flow.hostSeq = wrap32(flow.hostSeq + 1); // SYN consumes one sequence
    }

    _handleTcpData({ key, data }) {
        const flow = this.tcpFlows.get(key);
        // A guest FIN does not prevent us from delivering remaining response
        // data to the guest (TCP half-close). Only host-close stops new data.
        if (!flow || flow.hostClosed) return;
        flow.lastActivity = Date.now();
        flow.pending.push(Buffer.from(data));
        this._maybeSend(flow);
    }

    _handleTcpEnd(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow) return;
        flow.hostClosed = true;
        flow.lastActivity = Date.now();
        // FIN is sent from _maybeSend() once pending data is drained, so the
        // FIN never overtakes un-delivered bytes.
        this._maybeSend(flow);
    }

    _handleTcpError({ key }) {
        const flow = this.tcpFlows.get(key);
        if (!flow) return;
        this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort,
                     flow.hostSeq, flow.guestSeq, TCP_RST);
        this.tcpFlows.delete(key);
    }

    _handleTcpClosed(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow) return;
        flow.hostClosed = true;
        if (flow.guestClosed) this.tcpFlows.delete(key);
    }

    /* ------------------------------------------------------------------ *
     * UDP (DHCP + DNS + NAT)
     * ------------------------------------------------------------------ */

    handleUDP(segment, srcIP, dstIP) {
        if (segment.length < 8) return;
        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const payload = segment.subarray(8);

        // DHCP
        if (srcPort === DHCP_CLIENT_PORT && dstPort === DHCP_SERVER_PORT) {
            this.handleDHCP(payload);
            return;
        }

        // DNS: terminate locally, resolve via the host.
        if (dstPort === 53) {
            this._handleDnsQuery(srcIP, srcPort, payload);
            return;
        }

        const key = `UDP:${ipToString(srcIP)}:${srcPort}:${ipToString(dstIP)}:${dstPort}`;
        const flow = this.udpFlows.get(key) || {
            key,
            srcIP: ipToString(srcIP),
            srcPort,
            dstIP: ipToString(dstIP),
            dstPort,
            lastActivity: Date.now(),
        };
        flow.lastActivity = Date.now();
        this.udpFlows.set(key, flow);

        this._post({
            type: 'udp-send',
            key,
            dstIP: flow.dstIP,
            dstPort,
            srcIP: flow.srcIP,
            srcPort,
            payload: Array.from(payload),
        });
    }

    _handleUdpResponse({ data, srcIP, srcPort, dstIP, dstPort }) {
        const udpHeader = Buffer.alloc(8);
        udpHeader.writeUInt16BE(dstPort, 0);
        udpHeader.writeUInt16BE(srcPort, 2);
        udpHeader.writeUInt16BE(8 + data.length, 4);
        udpHeader.writeUInt16BE(0, 6);
        this.sendIP(Buffer.concat([udpHeader, Buffer.from(data)]), IP_PROTO_UDP,
                    ipToBuf(srcIP), ipToBuf(dstIP));
    }

    _handleDnsQuery(srcIP, srcPort, data) {
        if (data.length < 12) return;
        const id = data.readUInt16BE(0);
        const qdcount = data.readUInt16BE(4);
        if (qdcount !== 1) return;

        let off = 12;
        let name = '';
        while (off < data.length) {
            const len = data[off];
            if (len === 0) { off++; break; }
            if ((len & 0xc0) === 0xc0) { off += 2; break; } // pointer (rare in queries)
            if (off + 1 + len > data.length) return;
            name += (name ? '.' : '') + data.subarray(off + 1, off + 1 + len).toString('ascii');
            off += 1 + len;
        }
        if (off + 4 > data.length) return;
        const qtype = data.readUInt16BE(off);
        off += 4;

        const key = `DNS:${ipToString(srcIP)}:${srcPort}:${id}`;
        this.pendingDns.set(key, { srcIP: ipToString(srcIP), srcPort, id, name, qtype });
        this._post({ type: 'dns-lookup', key, name, qtype });
    }

    _handleDnsResult({ key, name, qtype, ips, error }) {
        const pending = this.pendingDns.get(key);
        if (!pending) return;
        this.pendingDns.delete(key);

        // Build a minimal DNS response. The gateway is IPv4-only, so we
        // answer A queries with IPv4 addresses and AAAA queries with an empty
        // NOERROR response. Returning no AAAA records forces the guest to use
        // IPv4, which this NAT can actually route (IPv6 frames would be dropped).
        const answers = [];
        if (!error && qtype === 1 && Array.isArray(ips)) {
            for (const ip of ips) {
                if (!String(ip).includes(':')) answers.push(ipToBuf(ip));
            }
        }

        const header = Buffer.alloc(12);
        header.writeUInt16BE(pending.id, 0);
        header.writeUInt16BE(0x8180, 2); // QR|RD|RA
        header.writeUInt16BE(1, 4); // QDCOUNT
        header.writeUInt16BE(answers.length, 6); // ANCOUNT
        header.writeUInt16BE(0, 8); // NSCOUNT
        header.writeUInt16BE(0, 10); // ARCOUNT

        const question = this._encodeDnsName(pending.name);
        const qtail = Buffer.alloc(4);
        qtail.writeUInt16BE(pending.qtype, 0);
        qtail.writeUInt16BE(1, 2); // IN

        const rrs = [];
        for (const rdata of answers) {
            const rr = Buffer.alloc(12 + rdata.length);
            rr.writeUInt16BE(0xc00c, 0); // pointer to question name
            rr.writeUInt16BE(pending.qtype, 2);
            rr.writeUInt16BE(1, 4); // class IN
            rr.writeUInt32BE(60, 6); // TTL
            rr.writeUInt16BE(rdata.length, 10); // RDLENGTH
            rdata.copy(rr, 12);
            rrs.push(rr);
        }

        const dnsResponse = Buffer.concat([header, question, qtail, ...rrs]);
        this._sendUdpToGuest(pending.srcIP, pending.srcPort, 53, dnsResponse);
    }

    _sendUdpToGuest(dstIP, dstPort, srcPort, payload) {
        const udpHeader = Buffer.alloc(8);
        udpHeader.writeUInt16BE(srcPort, 0);
        udpHeader.writeUInt16BE(dstPort, 2);
        udpHeader.writeUInt16BE(8 + payload.length, 4);
        udpHeader.writeUInt16BE(0, 6);
        this.sendIP(Buffer.concat([udpHeader, payload]), IP_PROTO_UDP,
                    ipToBuf(this.gatewayIP), ipToBuf(dstIP));
    }

    _encodeDnsName(name) {
        const parts = String(name).split('.').filter(Boolean);
        const bufs = [];
        for (const p of parts) {
            const b = Buffer.alloc(1 + p.length);
            b[0] = p.length;
            b.write(p, 1, 'ascii');
            bufs.push(b);
        }
        bufs.push(Buffer.from([0]));
        return Buffer.concat(bufs);
    }

    _ipv6ToBuf(ip) {
        // Minimal IPv6 address parser.
        const full = this._expandIpv6(String(ip));
        const groups = full.split(':').map((g) => parseInt(g || '0', 16));
        const buf = Buffer.alloc(16);
        groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2));
        return buf;
    }

    _expandIpv6(ip) {
        let [head, tail] = ip.split('::');
        head = head || '';
        tail = tail || '';
        const headParts = head ? head.split(':') : [];
        const tailParts = tail ? tail.split(':') : [];
        const missing = 8 - headParts.length - tailParts.length;
        return [...headParts, ...Array(missing).fill('0'), ...tailParts].join(':');
    }

    /* ------------------------------------------------------------------ *
     * DHCP (static lease)
     * ------------------------------------------------------------------ */

    handleDHCP(data) {
        if (data.length < 240) return;
        if (data[0] !== 1) return;
        const xid = data.readUInt32BE(4);
        const flags = data.readUInt16BE(10);
        const chaddr = data.subarray(28, 28 + 16);
        if (data.readUInt32BE(236) !== DHCP_MAGIC_COOKIE) return;

        let msgType = 0;
        let i = 240;
        while (i < data.length) {
            const opt = data[i];
            if (opt === DHCP_OPT_END) break;
            if (opt === 0) { i++; continue; }
            const len = data[i + 1];
            if (opt === DHCP_OPT_MSG_TYPE && len >= 1) msgType = data[i + 2];
            i += 2 + len;
        }

        if (msgType === DHCP_DISCOVER) this._sendDhcpReply(DHCP_OFFER, xid, chaddr, flags);
        else if (msgType === DHCP_REQUEST) this._sendDhcpReply(DHCP_ACK, xid, chaddr, flags);
    }

    _sendDhcpReply(msgType, xid, chaddr, flags) {
        const vmIPParts = this.vmIP.split('.').map(Number);
        const gwIPParts = this.gatewayIP.split('.').map(Number);

        const reply = Buffer.alloc(300);
        reply[0] = 2; // BOOTREPLY
        reply[1] = 1;
        reply[2] = 6;
        reply.writeUInt32BE(xid, 4);
        reply.writeUInt16BE(flags, 10);
        reply[16] = vmIPParts[0]; reply[17] = vmIPParts[1]; reply[18] = vmIPParts[2]; reply[19] = vmIPParts[3];
        reply[20] = gwIPParts[0]; reply[21] = gwIPParts[1]; reply[22] = gwIPParts[2]; reply[23] = gwIPParts[3];
        chaddr.copy(reply, 28);
        reply.writeUInt32BE(DHCP_MAGIC_COOKIE, 236);

        let o = 240;
        reply[o++] = DHCP_OPT_MSG_TYPE; reply[o++] = 1; reply[o++] = msgType;
        reply[o++] = DHCP_OPT_SERVER_ID; reply[o++] = 4;
        reply[o++] = gwIPParts[0]; reply[o++] = gwIPParts[1]; reply[o++] = gwIPParts[2]; reply[o++] = gwIPParts[3];
        reply[o++] = DHCP_OPT_LEASE_TIME; reply[o++] = 4;
        reply.writeUInt32BE(86400, o); o += 4;
        reply[o++] = DHCP_OPT_SUBNET_MASK; reply[o++] = 4;
        reply[o++] = 255; reply[o++] = 255; reply[o++] = 255; reply[o++] = 0;
        reply[o++] = DHCP_OPT_ROUTER; reply[o++] = 4;
        reply[o++] = gwIPParts[0]; reply[o++] = gwIPParts[1]; reply[o++] = gwIPParts[2]; reply[o++] = gwIPParts[3];
        reply[o++] = DHCP_OPT_DNS; reply[o++] = 4;
        reply[o++] = gwIPParts[0]; reply[o++] = gwIPParts[1]; reply[o++] = gwIPParts[2]; reply[o++] = gwIPParts[3];
        reply[o++] = DHCP_OPT_END;

        const udpHeader = Buffer.alloc(8);
        udpHeader.writeUInt16BE(DHCP_SERVER_PORT, 0);
        udpHeader.writeUInt16BE(DHCP_CLIENT_PORT, 2);
        udpHeader.writeUInt16BE(8 + 300, 4);
        udpHeader.writeUInt16BE(0, 6);

        const dstMac = (flags & 0x8000) ? Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : chaddr.subarray(0, 6);
        const ipPacket = this._buildIpPacket(ipToBuf(this.gatewayIP), ipToBuf('255.255.255.255'), IP_PROTO_UDP, Buffer.concat([udpHeader, reply]));

        const frame = Buffer.alloc(14 + ipPacket.length);
        dstMac.copy(frame, 0);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(ETH_P_IP, 12);
        ipPacket.copy(frame, 14);

        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        this.emit('network-activity');
        this.emit('dhcp', msgType === DHCP_OFFER ? 'OFFER' : 'ACK', this.vmIP);
    }

    _buildIpPacket(srcIP, dstIP, protocol, payload) {
        const header = Buffer.alloc(20);
        header[0] = 0x45;
        header[1] = 0;
        header.writeUInt16BE(20 + payload.length, 2);
        header.writeUInt16BE(0, 4);
        header.writeUInt16BE(0x4000, 6);
        header[8] = 64;
        header[9] = protocol;
        srcIP.copy(header, 12);
        dstIP.copy(header, 16);
        header.writeUInt16BE(this.calculateChecksum(header), 10);
        return Buffer.concat([header, payload]);
    }
}

module.exports = { NetworkStack };

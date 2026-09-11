const EventEmitter = require('node:events');
const { randomBytes } = require('node:crypto');
const {
    NET_MSG_TCP_CONNECTED,
    NET_MSG_TCP_DATA,
    NET_MSG_TCP_END,
    NET_MSG_TCP_ERROR,
    NET_MSG_TCP_CLOSE,
    NET_MSG_UDP_RECV,
    NET_MSG_DNS_RESULT,
} = require('./ringbuffer');

const ETH_P_IP = 0x0800;
const ETH_P_ARP = 0x0806;
const IP_PROTO_ICMP = 1;
const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;

const MSS = 1460;
const INITIAL_WINDOW = 65535;
const MAX_FRAME_SIZE = 65535;
const TCP_INITIAL_RTO_MS = 1000;
const TCP_MAX_RTO_MS = 30000;
// Linux commonly allows a stalled TCP connection to survive for many minutes.
// The emulated guest can spend minutes CPU-bound in npm extraction, so native-
// style timeouts are required; five-minute cleanup was resetting valid TLS
// handshakes and then making npm report ECONNRESET/EHOSTUNREACH.
const TCP_MAX_RETRANSMITS = 32;
const TCP_IDLE_REAP_MS = 30 * 60 * 1000;
const UDP_IDLE_REAP_MS = 30000;
const DNS_TIMEOUT_MS = 10000;
// TinyEMU's virtual NIC is much shallower than a native Linux NIC. Even when
// the guest advertises a multi-megabyte scaled window, injecting that whole
// window synchronously drops frames and leaves later SYN/DNS packets queued
// behind megabytes of data. Keep a small per-flow flight window and stop host
// reads before the worker backlog grows large.
const TCP_MAX_IN_FLIGHT = 32 * 1024;
// Bound the shared NIC queue across *all* flows. A per-flow window alone still
// permits npm's many parallel TLS downloads to enqueue several megabytes and
// overflow the guest virtio receive queue, starving even prioritized DNS.
const NIC_TX_HIGH_WATER = 256 * 1024;
const FLOW_HIGH_WATER = 128 * 1024;
const FLOW_LOW_WATER = 32 * 1024;

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

const EMPTY = Buffer.alloc(0);

function ipToString(buf) {
    return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function ipToBuf(str) {
    const parts = String(str).split('.');
    if (parts.length !== 4) return null;
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return Buffer.from(numbers);
}

function wrap32(value) {
    return value >>> 0;
}

function seqLt(a, b) {
    return ((a - b) | 0) < 0;
}

function seqGt(a, b) {
    return ((a - b) | 0) > 0;
}

function seqGeq(a, b) {
    return ((a - b) | 0) >= 0;
}

function seqDistance(from, to) {
    return (to - from) >>> 0;
}

class NetworkStack extends EventEmitter {
    constructor(options = {}) {
        super();
        this.gatewayIP = options.gatewayIP || '192.168.127.1';
        this.vmIP = options.vmIP || '192.168.127.3';
        this.gatewayMac = options.gatewayMac
            ? Buffer.from(options.gatewayMac)
            : Buffer.from([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
        this.vmMac = options.vmMac
            ? Buffer.from(options.vmMac)
            : Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
        this.ringReader = options.ringReader || null;
        this.netPort = options.netPort || null;
        this.debugStats = !!options.debugStats;
        this.lastDebugStats = 0;

        // QEMU's socket backend is one permanent byte stream containing
        // uint32-be-length-prefixed Ethernet frames. Keep it independent of
        // the lifetime of every TCP/UDP flow carried inside it.
        this.rxBuffer = EMPTY;
        this.txChunks = [];
        this.txOffset = 0;
        this.txBytes = 0;

        this.tcpFlows = new Map();
        this.udpFlows = new Map();
        // Compatibility aliases for callers of the original NetworkStack.
        this.natTable = this.tcpFlows;
        this.udpTable = this.udpFlows;
        this.pendingDns = new Map();
    }

    hasNetworkData() {
        return !!(this.ringReader && this.ringReader.hasNetworkData());
    }

    writeToNetwork(data) {
        if (!data || data.length === 0) return;
        const incoming = Buffer.from(data);
        this.rxBuffer = this.rxBuffer.length === 0
            ? incoming
            : Buffer.concat([this.rxBuffer, incoming]);

        while (this.rxBuffer.length >= 4) {
            const frameLength = this.rxBuffer.readUInt32BE(0);
            if (frameLength < 14 || frameLength > MAX_FRAME_SIZE) {
                // There is no reliable way to resynchronise a length-prefixed
                // stream after a corrupt prefix. Drop it rather than retaining
                // attacker-controlled memory forever.
                this.rxBuffer = EMPTY;
                this._reportError(new Error(`invalid Ethernet frame length: ${frameLength}`));
                return;
            }
            if (this.rxBuffer.length < frameLength + 4) break;
            const frame = this.rxBuffer.subarray(4, frameLength + 4);
            this.rxBuffer = this.rxBuffer.subarray(frameLength + 4);
            try {
                this.receive(frame);
            } catch (error) {
                this._reportError(error);
            }
        }

        if (this.rxBuffer.length > MAX_FRAME_SIZE + 4) {
            this.rxBuffer = EMPTY;
            this._reportError(new Error('Ethernet frame reassembly buffer overflow'));
        }
    }

    _reportError(error) {
        if (this.listenerCount('error') > 0) this.emit('error', error);
    }

    _queueFrame(frame, priority = false) {
        const framed = Buffer.allocUnsafe(4 + frame.length);
        framed.writeUInt32BE(frame.length, 0);
        frame.copy(framed, 4);
        if (priority) {
            // Never insert ahead of a partially-read framed packet: that would
            // corrupt the QEMU byte stream. Control traffic may otherwise pass
            // queued bulk data so new handshakes and ACKs cannot starve.
            this.txChunks.splice(this.txOffset > 0 ? 1 : 0, 0, framed);
        } else {
            this.txChunks.push(framed);
        }
        this.txBytes += framed.length;
        this.emit('network-activity');
    }

    readFromNetwork(maxLength) {
        if (this.txBytes === 0 || maxLength <= 0) return null;
        const length = Math.min(maxLength, this.txBytes);
        const first = this.txChunks[0];
        const available = first.length - this.txOffset;

        // The common case is a single queued Ethernet frame. Return a view of
        // the existing buffer instead of allocating and copying a fresh one.
        // The underlying buffer stays referenced by this view even after the
        // chunk is shifted, so the returned data remains valid.
        let result;
        if (available >= length) {
            result = first.subarray(this.txOffset, this.txOffset + length);
            this.txOffset += length;
            if (this.txOffset === first.length) {
                this.txChunks.shift();
                this.txOffset = 0;
            }
        } else {
            result = Buffer.allocUnsafe(length);
            let written = 0;
            while (written < length) {
                const chunk = this.txChunks[0];
                const count = Math.min(chunk.length - this.txOffset, length - written);
                chunk.copy(result, written, this.txOffset, this.txOffset + count);
                written += count;
                this.txOffset += count;
                if (this.txOffset === chunk.length) {
                    this.txChunks.shift();
                    this.txOffset = 0;
                }
            }
        }
        this.txBytes -= length;

        // Reading from the frame pipe creates room for pending TCP data. Pump
        // all flows here so host sockets resume without waiting for an
        // unrelated ACK or host event.
        if (this.txBytes < NIC_TX_HIGH_WATER) this._pumpTcpFlows();
        return result;
    }

    _pumpTcpFlows() {
        for (const flow of this.tcpFlows.values()) {
            if (this.txBytes >= NIC_TX_HIGH_WATER) break;
            this._maybeSend(flow);
        }
    }

    // Legacy inspection surface. Internal reads use the chunk queue to avoid
    // quadratic Buffer.concat behavior on large transfers.
    get txBuffer() {
        if (this.txBytes === 0) return EMPTY;
        const chunks = this.txChunks.slice();
        if (this.txOffset > 0) chunks[0] = chunks[0].subarray(this.txOffset);
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, this.txBytes);
    }

    hasPendingData() {
        return this.txBytes > 0;
    }

    pendingDataSize() {
        return this.txBytes;
    }

    closeSocket() {
        for (const key of this.tcpFlows.keys()) this._destroyHost(key, true);
        for (const key of this.udpFlows.keys()) this._post({ type: 'udp-close', key });
        this.tcpFlows.clear();
        this.udpFlows.clear();
        this.pendingDns.clear();
    }

    pollNetResponses() {
        if (!this.ringReader) return;
        let message;
        let count = 0;
        while ((message = this.ringReader.readNetworkMessage())) {
            count++;
            switch (message.type) {
                case NET_MSG_TCP_CONNECTED:
                    this._handleTcpConnected(this.ringReader.parseKey(message.payload));
                    break;
                case NET_MSG_TCP_DATA:
                    this._handleTcpData(this.ringReader.parseTcpData(message.payload));
                    break;
                case NET_MSG_TCP_END:
                    this._handleTcpEnd(this.ringReader.parseKey(message.payload));
                    break;
                case NET_MSG_TCP_ERROR:
                    this._handleTcpError(this.ringReader.parseTcpError(message.payload));
                    break;
                case NET_MSG_TCP_CLOSE:
                    this._handleTcpClosed(this.ringReader.parseKey(message.payload));
                    break;
                case NET_MSG_UDP_RECV:
                    this._handleUdpResponse(this.ringReader.parseUdpRecv(message.payload));
                    break;
                case NET_MSG_DNS_RESULT:
                    this._handleDnsResult(this.ringReader.parseDnsResult(message.payload));
                    break;
            }
        }
        if (count) this.emit('network-activity');
    }

    tick(now = Date.now()) {
        for (const [key, flow] of this.tcpFlows) {
            if (now - flow.lastActivity > TCP_IDLE_REAP_MS) {
                this._sendTcp(flow, flow.sendNext, flow.guestNext, TCP_RST);
                this._destroyHost(key, true);
                this.tcpFlows.delete(key);
                continue;
            }
            this._retransmit(flow, now);
        }
        for (const [key, flow] of this.udpFlows) {
            if (now - flow.lastActivity > UDP_IDLE_REAP_MS) {
                this._post({ type: 'udp-close', key });
                this.udpFlows.delete(key);
            }
        }
        for (const [key, query] of this.pendingDns) {
            if (now - query.createdAt > DNS_TIMEOUT_MS) {
                this.pendingDns.delete(key);
                this._sendDnsResponse(query, [], 2); // SERVFAIL
            }
        }
        if (this.debugStats && now - this.lastDebugStats >= 10000) {
            this.lastDebugStats = now;
            const flows = [...this.tcpFlows.values()].map((flow) => ({
                key: flow.key,
                state: flow.state,
                window: flow.guestWindow,
                inFlight: seqDistance(flow.sendUna, flow.sendNext),
                pending: flow.pendingBytes,
                unacked: flow.unacked.length,
                retries: flow.retransmits,
                rto: flow.retransmitTimeout,
                idle: now - flow.lastActivity,
                hostClosed: flow.hostClosed,
                guestClosed: flow.guestClosed,
            }));
            this.emit('debug', `network stats ${JSON.stringify({ tcp: flows, udp: this.udpFlows.size, dns: this.pendingDns.size, tx: this.txBytes })}`);
        }
    }

    _post(message) {
        if (this.netPort) this.netPort.postMessage(message);
    }

    _destroyHost(key, destroy) {
        this._post({ type: 'tcp-close', key, destroy: !!destroy });
    }

    send(payload, etherType, priority = false) {
        if (!this.vmMac) return;
        const frame = Buffer.allocUnsafe(14 + payload.length);
        this.vmMac.copy(frame, 0);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(etherType, 12);
        payload.copy(frame, 14);
        this._queueFrame(frame, priority);
        this.emit('tx', frame);
    }

    sendBroadcast(payload, etherType) {
        const frame = Buffer.allocUnsafe(14 + payload.length);
        frame.fill(0xff, 0, 6);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(etherType, 12);
        payload.copy(frame, 14);
        this._queueFrame(frame);
        this.emit('tx', frame);
    }

    receive(frame) {
        if (!Buffer.isBuffer(frame)) frame = Buffer.from(frame);
        if (frame.length < 14) return;
        const etherType = frame.readUInt16BE(12);
        if (!this.vmMac) this.vmMac = Buffer.from(frame.subarray(6, 12));
        const payload = frame.subarray(14);
        if (etherType === ETH_P_ARP) this.handleARP(payload);
        else if (etherType === ETH_P_IP) this.handleIP(payload);
    }

    handleARP(packet) {
        if (packet.length < 28) return;
        if (packet.readUInt16BE(0) !== 1 || packet.readUInt16BE(2) !== ETH_P_IP) return;
        if (packet[4] !== 6 || packet[5] !== 4 || packet.readUInt16BE(6) !== 1) return;
        if (ipToString(packet.subarray(24, 28)) !== this.gatewayIP) return;

        const reply = Buffer.alloc(28);
        packet.copy(reply, 0, 0, 8);
        reply.writeUInt16BE(2, 6);
        this.gatewayMac.copy(reply, 8);
        packet.subarray(24, 28).copy(reply, 14);
        packet.subarray(8, 14).copy(reply, 18);
        packet.subarray(14, 18).copy(reply, 24);
        this.send(reply, ETH_P_ARP);
    }

    handleIP(packet) {
        if (packet.length < 20 || (packet[0] >>> 4) !== 4) return;
        const headerLength = (packet[0] & 0x0f) * 4;
        if (headerLength < 20 || headerLength > packet.length) return;
        const totalLength = packet.readUInt16BE(2);
        if (totalLength < headerLength || totalLength > packet.length) return;
        // This small gateway does not reassemble IPv4 fragments.
        if ((packet.readUInt16BE(6) & 0x3fff) !== 0) return;
        if (this.calculateChecksum(packet.subarray(0, headerLength)) !== 0) return;

        const protocol = packet[9];
        const srcIP = packet.subarray(12, 16);
        const dstIP = packet.subarray(16, 20);
        const payload = packet.subarray(headerLength, totalLength);
        if (protocol === IP_PROTO_ICMP) this.handleICMP(payload, srcIP, dstIP);
        else if (protocol === IP_PROTO_TCP) this.handleTCP(payload, srcIP, dstIP);
        else if (protocol === IP_PROTO_UDP) this.handleUDP(payload, srcIP, dstIP);
    }

    calculateChecksum(buffer) {
        let sum = 0;
        for (let i = 0; i + 1 < buffer.length; i += 2) sum += buffer.readUInt16BE(i);
        if (buffer.length & 1) sum += buffer[buffer.length - 1] << 8;
        while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
        return (~sum) & 0xffff;
    }

    handleICMP(data, srcIP, dstIP) {
        if (data.length < 8 || data[0] !== 8 || data[1] !== 0) return;
        if (this.calculateChecksum(data) !== 0) return;
        const reply = Buffer.from(data);
        reply[0] = 0;
        reply.writeUInt16BE(0, 2);
        reply.writeUInt16BE(this.calculateChecksum(reply), 2);
        this.sendIP(reply, IP_PROTO_ICMP, dstIP, srcIP);
    }

    _buildIpPacket(srcIP, dstIP, protocol, payload) {
        const header = Buffer.alloc(20);
        header[0] = 0x45;
        header.writeUInt16BE(20 + payload.length, 2);
        header.writeUInt16BE(0x4000, 6);
        header[8] = 64;
        header[9] = protocol;
        srcIP.copy(header, 12);
        dstIP.copy(header, 16);
        header.writeUInt16BE(this.calculateChecksum(header), 10);
        const packet = Buffer.allocUnsafe(20 + payload.length);
        header.copy(packet, 0);
        payload.copy(packet, 20);
        return packet;
    }

    sendIP(payload, protocol, srcIP, dstIP, priority = false) {
        const packet = this._buildIpPacket(srcIP, dstIP, protocol, payload);
        const broadcast = dstIP.every((byte) => byte === 255);
        if (broadcast) this.sendBroadcast(packet, ETH_P_IP);
        else this.send(packet, ETH_P_IP, priority);
    }

    _tcpKey(srcIP, srcPort, dstIP, dstPort) {
        return `TCP:${ipToString(srcIP)}:${srcPort}:${ipToString(dstIP)}:${dstPort}`;
    }

    _parseTcpOptions(segment, headerLength) {
        let windowScale = 0;
        let mss = 536;
        for (let offset = 20; offset < headerLength;) {
            const kind = segment[offset];
            if (kind === 0) break;
            if (kind === 1) {
                offset++;
                continue;
            }
            if (offset + 1 >= headerLength) break;
            const length = segment[offset + 1];
            if (length < 2 || offset + length > headerLength) break;
            if (kind === 2 && length === 4) mss = segment.readUInt16BE(offset + 2);
            if (kind === 3 && length === 3) windowScale = Math.min(segment[offset + 2], 14);
            offset += length;
        }
        return { windowScale, mss: Math.max(64, Math.min(MSS, mss)) };
    }

    sendTCP(dstIP, dstPort, srcIP, srcPort, seq, ack, flags, payload = EMPTY, options = EMPTY) {
        const paddedOptionsLength = (options.length + 3) & ~3;
        const header = Buffer.alloc(20 + paddedOptionsLength);
        header.writeUInt16BE(srcPort, 0);
        header.writeUInt16BE(dstPort, 2);
        header.writeUInt32BE(wrap32(seq), 4);
        header.writeUInt32BE(wrap32(ack), 8);
        header[12] = (header.length / 4) << 4;
        header[13] = flags;
        header.writeUInt16BE(INITIAL_WINDOW, 14);
        options.copy(header, 20);

        const pseudo = Buffer.alloc(12);
        srcIP.copy(pseudo, 0);
        dstIP.copy(pseudo, 4);
        pseudo[9] = IP_PROTO_TCP;
        pseudo.writeUInt16BE(header.length + payload.length, 10);
        header.writeUInt16BE(this.calculateChecksum(Buffer.concat([pseudo, header, payload])), 16);
        // SYN-ACK/RST can safely bypass unrelated bulk flows. ACK/FIN carry a
        // sequence number relative to this flow's queued data and must remain
        // ordered behind it.
        const priority = (flags & (TCP_SYN | TCP_RST)) !== 0;
        this.sendIP(Buffer.concat([header, payload]), IP_PROTO_TCP, srcIP, dstIP, priority);
    }

    _sendTcp(flow, seq, ack, flags, data = EMPTY, options = EMPTY) {
        this.sendTCP(flow.srcIP, flow.srcPort, flow.dstIP, flow.dstPort, seq, ack, flags, data, options);
    }

    _sendTracked(flow, flags, data = EMPTY, options = EMPTY) {
        const seq = flow.sendNext;
        const sequenceLength = data.length + ((flags & TCP_SYN) ? 1 : 0) + ((flags & TCP_FIN) ? 1 : 0);
        this._sendTcp(flow, seq, flow.guestNext, flags, data, options);
        if (sequenceLength > 0) {
            flow.unacked.push({
                seq,
                end: wrap32(seq + sequenceLength),
                flags,
                data: Buffer.from(data),
                options: Buffer.from(options),
                sentAt: Date.now(),
            });
            flow.sendNext = wrap32(flow.sendNext + sequenceLength);
        }
    }

    _sendReset(srcIP, srcPort, dstIP, dstPort, seq, ack, flags, payloadLength) {
        if (flags & TCP_ACK) {
            this.sendTCP(srcIP, srcPort, dstIP, dstPort, ack, 0, TCP_RST);
        } else {
            const consumed = payloadLength + ((flags & TCP_SYN) ? 1 : 0) + ((flags & TCP_FIN) ? 1 : 0);
            this.sendTCP(srcIP, srcPort, dstIP, dstPort, 0, wrap32(seq + consumed), TCP_RST | TCP_ACK);
        }
    }

    handleTCP(segment, srcIP, dstIP) {
        if (segment.length < 20) return;
        const headerLength = (segment[12] >>> 4) * 4;
        if (headerLength < 20 || headerLength > segment.length) return;

        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const seq = segment.readUInt32BE(4);
        const ack = segment.readUInt32BE(8);
        const flags = segment[13];
        const rawWindow = segment.readUInt16BE(14);
        const payload = segment.subarray(headerLength);
        const key = this._tcpKey(srcIP, srcPort, dstIP, dstPort);
        let flow = this.tcpFlows.get(key);

        if (flags & TCP_RST) {
            if (flow) {
                this._destroyHost(key, true);
                this.tcpFlows.delete(key);
            }
            return;
        }

        if (!flow) {
            if (!(flags & TCP_SYN)) {
                this._sendReset(srcIP, srcPort, dstIP, dstPort, seq, ack, flags, payload.length);
                return;
            }
            const options = this._parseTcpOptions(segment, headerLength);
            const initialSequence = randomBytes(4).readUInt32BE(0);
            flow = {
                key,
                srcIP: Buffer.from(srcIP),
                srcPort,
                dstIP: Buffer.from(dstIP),
                dstPort,
                state: 'SYN_SENT',
                guestNext: wrap32(seq + 1),
                windowScale: options.windowScale,
                peerMss: options.mss,
                guestWindow: rawWindow,
                sendUna: initialSequence,
                sendNext: initialSequence,
                pending: [],
                pendingBytes: 0,
                unacked: [],
                hostClosed: false,
                guestClosed: false,
                finSent: false,
                finAcked: false,
                hostCloseRequested: false,
                hostPaused: false,
                retransmits: 0,
                retransmitTimeout: TCP_INITIAL_RTO_MS,
                lastActivity: Date.now(),
            };
            this.tcpFlows.set(key, flow);
            this._post({
                type: 'tcp-connect', key,
                dstIP: ipToString(dstIP), dstPort,
                srcIP: ipToString(srcIP), srcPort,
            });
            return;
        }

        flow.lastActivity = Date.now();

        // A retransmitted SYN is common when host connect/DNS is slow. Once a
        // SYN-ACK exists, retransmit it immediately instead of opening a new
        // host socket or treating the SYN as guest data.
        if (flags & TCP_SYN) {
            if (flow.state === 'SYN_RECEIVED' && flow.unacked.length > 0) {
                const syn = flow.unacked[0];
                this._sendTcp(flow, syn.seq, flow.guestNext, syn.flags, syn.data, syn.options);
                syn.sentAt = Date.now();
            }
            return;
        }

        if (flags & TCP_ACK) {
            flow.guestWindow = Math.min(0x7fffffff, rawWindow * (2 ** flow.windowScale));
            this._acknowledge(flow, ack);
        }

        // Do not forward data until the guest has acknowledged our SYN.
        if (flow.state === 'SYN_SENT' || flow.state === 'SYN_RECEIVED') {
            this._maybeSend(flow);
            return;
        }

        let data = payload;
        let dataSeq = seq;
        if (data.length > 0) {
            if (seqLt(dataSeq, flow.guestNext)) {
                const duplicate = Math.min(data.length, seqDistance(dataSeq, flow.guestNext));
                data = data.subarray(duplicate);
                dataSeq = wrap32(dataSeq + duplicate);
            }
            if (data.length > 0 && dataSeq === flow.guestNext && !flow.guestClosed) {
                this._post({ type: 'tcp-send', key, data: Buffer.from(data) });
                flow.guestNext = wrap32(flow.guestNext + data.length);
            }
            // Out-of-order and duplicate bytes are never forwarded to the
            // host. A cumulative ACK tells the guest what to retransmit.
            this._sendTcp(flow, flow.sendNext, flow.guestNext, TCP_ACK);
        }

        if (flags & TCP_FIN) {
            const finSeq = wrap32(seq + payload.length);
            if (finSeq === flow.guestNext) {
                flow.guestNext = wrap32(flow.guestNext + 1);
                flow.guestClosed = true;
                flow.state = flow.hostClosed ? 'CLOSING' : 'CLOSE_WAIT';
                if (!flow.hostCloseRequested) {
                    flow.hostCloseRequested = true;
                    this._post({ type: 'tcp-close', key, destroy: false });
                }
            }
            this._sendTcp(flow, flow.sendNext, flow.guestNext, TCP_ACK);
        }

        this._maybeSend(flow);
        this._maybeCloseFlow(flow);
    }

    _acknowledge(flow, ack) {
        if (seqLt(ack, flow.sendUna) || seqGt(ack, flow.sendNext)) return;
        if (ack === flow.sendUna) return;

        flow.sendUna = ack;
        while (flow.unacked.length > 0) {
            const entry = flow.unacked[0];
            if (seqGeq(ack, entry.end)) {
                flow.unacked.shift();
                if (entry.flags & TCP_SYN && flow.state === 'SYN_RECEIVED') flow.state = 'ESTABLISHED';
                if (entry.flags & TCP_FIN) flow.finAcked = true;
                continue;
            }
            if (seqGt(ack, entry.seq) && entry.data.length > 0) {
                const count = Math.min(entry.data.length, seqDistance(entry.seq, ack));
                entry.data = entry.data.subarray(count);
                entry.seq = ack;
                entry.sentAt = Date.now();
            }
            break;
        }

        // ACK progress proves the path is alive. Restart the RTO for the new
        // oldest segment instead of allowing retries accumulated while a slow
        // guest was draining earlier data to tear down the flow.
        flow.retransmits = 0;
        flow.retransmitTimeout = TCP_INITIAL_RTO_MS;
        if (flow.unacked.length > 0) flow.unacked[0].sentAt = Date.now();
        this._maybeSend(flow);
        this._updateBackpressure(flow);
        this._maybeCloseFlow(flow);
    }

    _maybeSend(flow) {
        if (flow.state === 'SYN_SENT' || flow.state === 'SYN_RECEIVED') return;
        const sendWindow = Math.min(flow.guestWindow, TCP_MAX_IN_FLIGHT);
        let available = Math.max(0, sendWindow - seqDistance(flow.sendUna, flow.sendNext));

        while (flow.pending.length > 0 && available > 0 && this.txBytes < NIC_TX_HIGH_WATER) {
            const chunk = flow.pending[0];
            const length = Math.min(flow.peerMss, chunk.length, available);
            if (length === 0) break;
            const data = chunk.subarray(0, length);
            if (length === chunk.length) flow.pending.shift();
            else flow.pending[0] = chunk.subarray(length);
            flow.pendingBytes -= length;
            const isLastBufferedChunk = flow.pending.length === 0;
            this._sendTracked(flow, TCP_ACK | (isLastBufferedChunk ? TCP_PSH : 0), data);
            available -= length;
        }

        if (flow.hostClosed && !flow.finSent && flow.pendingBytes === 0 && available > 0) {
            flow.finSent = true;
            flow.state = flow.guestClosed ? 'LAST_ACK' : 'FIN_WAIT_1';
            this._sendTracked(flow, TCP_FIN | TCP_ACK);
        }
        this._updateBackpressure(flow);
    }

    _updateBackpressure(flow) {
        if (!flow.hostPaused && flow.pendingBytes >= FLOW_HIGH_WATER) {
            flow.hostPaused = true;
            this._post({ type: 'tcp-pause', key: flow.key });
        } else if (flow.hostPaused && flow.pendingBytes <= FLOW_LOW_WATER) {
            flow.hostPaused = false;
            this._post({ type: 'tcp-resume', key: flow.key });
        }
    }

    _maybeCloseFlow(flow) {
        if (!flow.guestClosed || !flow.finSent || !flow.finAcked || flow.pendingBytes !== 0) return;
        flow.state = 'CLOSED';
        this.tcpFlows.delete(flow.key);
        this._destroyHost(flow.key, false);
    }

    _retransmit(flow, now) {
        // TCP retransmits the oldest unacknowledged segment. Retransmitting the
        // entire window on every timer creates a storm and used to exhaust the
        // retry budget in a few seconds when the emulated VM paused for npm
        // extraction or filesystem writes.
        const entry = flow.unacked[0];
        if (!entry || now - entry.sentAt < flow.retransmitTimeout) return;
        if (flow.retransmits >= TCP_MAX_RETRANSMITS) {
            this._sendTcp(flow, flow.sendNext, flow.guestNext, TCP_RST);
            this._destroyHost(flow.key, true);
            this.tcpFlows.delete(flow.key);
            return;
        }
        entry.sentAt = now;
        flow.retransmits++;
        flow.retransmitTimeout = Math.min(TCP_MAX_RTO_MS, flow.retransmitTimeout * 2);
        this._sendTcp(flow, entry.seq, flow.guestNext, entry.flags, entry.data, entry.options);
    }

    _handleTcpConnected(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow || flow.state !== 'SYN_SENT') return;
        flow.state = 'SYN_RECEIVED';
        flow.lastActivity = Date.now();
        // Advertise an Ethernet-sized MSS. Window scale must be echoed for the
        // guest's scale factor to take effect; scale zero keeps our own receive
        // window at the advertised 65535 bytes.
        this._sendTracked(flow, TCP_SYN | TCP_ACK, EMPTY,
            Buffer.from([2, 4, 0x05, 0xb4, 1, 3, 3, 0]));
    }

    _handleTcpData({ key, data }) {
        const flow = this.tcpFlows.get(key);
        if (!flow || flow.hostClosed) return;
        const chunk = Buffer.from(data);
        if (chunk.length === 0) return;
        flow.lastActivity = Date.now();
        flow.pending.push(chunk);
        flow.pendingBytes += chunk.length;
        this._maybeSend(flow);
    }

    _handleTcpEnd(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow || flow.hostClosed) return;
        flow.hostClosed = true;
        flow.lastActivity = Date.now();
        this._maybeSend(flow);
    }

    _handleTcpError({ key }) {
        const flow = this.tcpFlows.get(key);
        if (!flow) return;
        this._sendTcp(flow, flow.sendNext, flow.guestNext, TCP_RST);
        this.tcpFlows.delete(key);
    }

    _handleTcpClosed(key) {
        const flow = this.tcpFlows.get(key);
        if (!flow) return;
        // Node emits close after end. If close arrives without end, still
        // represent the orderly host shutdown to the guest.
        if (!flow.hostClosed) {
            flow.hostClosed = true;
            flow.lastActivity = Date.now();
            this._maybeSend(flow);
        }
    }

    handleUDP(segment, srcIP, dstIP) {
        if (segment.length < 8) return;
        const length = segment.readUInt16BE(4);
        if (length < 8 || length > segment.length) return;
        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const payload = segment.subarray(8, length);

        if (srcPort === DHCP_CLIENT_PORT && dstPort === DHCP_SERVER_PORT) {
            this.handleDHCP(payload);
            return;
        }
        if (dstPort === 53) {
            this._handleDnsQuery(srcIP, srcPort, dstIP, payload);
            return;
        }

        const key = `UDP:${ipToString(srcIP)}:${srcPort}:${ipToString(dstIP)}:${dstPort}`;
        let flow = this.udpFlows.get(key);
        if (!flow) {
            flow = {
                key,
                srcIP: ipToString(srcIP), srcPort,
                dstIP: ipToString(dstIP), dstPort,
                lastActivity: Date.now(),
            };
            this.udpFlows.set(key, flow);
        }
        flow.lastActivity = Date.now();
        this._post({
            type: 'udp-send', key,
            dstIP: flow.dstIP, dstPort: flow.dstPort,
            srcIP: flow.srcIP, srcPort: flow.srcPort,
            payload: Buffer.from(payload),
        });
    }

    _handleUdpResponse({ key, data }) {
        const flow = this.udpFlows.get(key);
        if (!flow) return;
        flow.lastActivity = Date.now();
        const payload = Buffer.from(data);
        const header = Buffer.alloc(8);
        header.writeUInt16BE(flow.dstPort, 0);
        header.writeUInt16BE(flow.srcPort, 2);
        header.writeUInt16BE(8 + payload.length, 4);
        this.sendIP(Buffer.concat([header, payload]), IP_PROTO_UDP,
            ipToBuf(flow.dstIP), ipToBuf(flow.srcIP));
    }

    _handleDnsQuery(srcIP, srcPort, dstIP, data) {
        if (data.length < 12) return;
        const id = data.readUInt16BE(0);
        if (data.readUInt16BE(4) !== 1) return;

        let offset = 12;
        const labels = [];
        let encodedLength = 0;
        while (offset < data.length) {
            const length = data[offset++];
            if (length === 0) break;
            // Compression pointers are unnecessary and unsafe in a one-name
            // query; reject them rather than following arbitrary offsets.
            if ((length & 0xc0) !== 0 || length > 63 || offset + length > data.length) return;
            labels.push(data.subarray(offset, offset + length).toString('ascii'));
            offset += length;
            encodedLength += length + 1;
            if (encodedLength > 255) return;
        }
        if (labels.length === 0 || offset + 4 > data.length) return;
        const qtype = data.readUInt16BE(offset);
        const qclass = data.readUInt16BE(offset + 2);
        if (qclass !== 1) return;

        const name = labels.join('.');
        const key = `DNS:${ipToString(srcIP)}:${srcPort}:${id}`;
        const previous = this.pendingDns.get(key);
        if (previous) this._sendDnsResponse(previous, [], 2);
        const query = {
            key,
            srcIP: ipToString(srcIP), srcPort,
            dnsIP: ipToString(dstIP),
            id, name, qtype,
            createdAt: Date.now(),
        };
        this.pendingDns.set(key, query);

        // This NAT is IPv4-only. AAAA and unsupported record types receive an
        // immediate empty NOERROR response, avoiding unusable IPv6 attempts.
        if (qtype !== 1) {
            this.pendingDns.delete(key);
            this._sendDnsResponse(query, [], 0);
            return;
        }
        this._post({ type: 'dns-lookup', key, name, qtype });
    }

    _handleDnsResult({ key, ips, error }) {
        const query = this.pendingDns.get(key);
        if (!query) return;
        this.pendingDns.delete(key);
        const addresses = [];
        if (!error && Array.isArray(ips)) {
            for (const ip of ips) {
                const encoded = ipToBuf(ip);
                if (encoded) addresses.push(encoded);
            }
        }
        this._sendDnsResponse(query, addresses, error ? 2 : 0);
    }

    _sendDnsResponse(query, addresses, rcode) {
        const header = Buffer.alloc(12);
        header.writeUInt16BE(query.id, 0);
        header.writeUInt16BE(0x8180 | (rcode & 0x0f), 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(addresses.length, 6);

        const question = this._encodeDnsName(query.name);
        const qtail = Buffer.alloc(4);
        qtail.writeUInt16BE(query.qtype, 0);
        qtail.writeUInt16BE(1, 2);
        const answers = addresses.map((address) => {
            const rr = Buffer.alloc(16);
            rr.writeUInt16BE(0xc00c, 0);
            rr.writeUInt16BE(1, 2);
            rr.writeUInt16BE(1, 4);
            rr.writeUInt32BE(60, 6);
            rr.writeUInt16BE(4, 10);
            address.copy(rr, 12);
            return rr;
        });
        this._sendUdpToGuest(query.srcIP, query.srcPort, 53,
            Buffer.concat([header, question, qtail, ...answers]), query.dnsIP);
    }

    _sendUdpToGuest(dstIP, dstPort, srcPort, payload, srcIP = this.gatewayIP) {
        const header = Buffer.alloc(8);
        header.writeUInt16BE(srcPort, 0);
        header.writeUInt16BE(dstPort, 2);
        header.writeUInt16BE(8 + payload.length, 4);
        this.sendIP(Buffer.concat([header, payload]), IP_PROTO_UDP, ipToBuf(srcIP), ipToBuf(dstIP), true);
    }

    _encodeDnsName(name) {
        const result = [];
        for (const label of String(name).split('.').filter(Boolean)) {
            const bytes = Buffer.from(label, 'ascii');
            result.push(Buffer.from([bytes.length]), bytes);
        }
        result.push(Buffer.from([0]));
        return Buffer.concat(result);
    }

    handleDHCP(data) {
        if (data.length < 240 || data[0] !== 1 || data.readUInt32BE(236) !== DHCP_MAGIC_COOKIE) return;
        const xid = data.readUInt32BE(4);
        const flags = data.readUInt16BE(10);
        const chaddr = data.subarray(28, 44);
        let messageType = 0;
        for (let offset = 240; offset < data.length;) {
            const option = data[offset++];
            if (option === DHCP_OPT_END) break;
            if (option === 0) continue;
            if (offset >= data.length) return;
            const length = data[offset++];
            if (offset + length > data.length) return;
            if (option === DHCP_OPT_MSG_TYPE && length >= 1) messageType = data[offset];
            offset += length;
        }
        if (messageType === DHCP_DISCOVER) this._sendDhcpReply(DHCP_OFFER, xid, chaddr, flags);
        else if (messageType === DHCP_REQUEST) this._sendDhcpReply(DHCP_ACK, xid, chaddr, flags);
    }

    _sendDhcpReply(messageType, xid, chaddr, flags) {
        const vmIP = ipToBuf(this.vmIP);
        const gatewayIP = ipToBuf(this.gatewayIP);
        const reply = Buffer.alloc(300);
        reply[0] = 2;
        reply[1] = 1;
        reply[2] = 6;
        reply.writeUInt32BE(xid, 4);
        reply.writeUInt16BE(flags, 10);
        vmIP.copy(reply, 16);
        gatewayIP.copy(reply, 20);
        chaddr.copy(reply, 28);
        reply.writeUInt32BE(DHCP_MAGIC_COOKIE, 236);

        let offset = 240;
        reply[offset++] = DHCP_OPT_MSG_TYPE; reply[offset++] = 1; reply[offset++] = messageType;
        reply[offset++] = DHCP_OPT_SERVER_ID; reply[offset++] = 4; gatewayIP.copy(reply, offset); offset += 4;
        reply[offset++] = DHCP_OPT_LEASE_TIME; reply[offset++] = 4; reply.writeUInt32BE(86400, offset); offset += 4;
        reply[offset++] = DHCP_OPT_SUBNET_MASK; reply[offset++] = 4;
        reply[offset++] = 255; reply[offset++] = 255; reply[offset++] = 255; reply[offset++] = 0;
        reply[offset++] = DHCP_OPT_ROUTER; reply[offset++] = 4; gatewayIP.copy(reply, offset); offset += 4;
        reply[offset++] = DHCP_OPT_DNS; reply[offset++] = 4; gatewayIP.copy(reply, offset); offset += 4;
        reply[offset] = DHCP_OPT_END;

        const udp = Buffer.alloc(8);
        udp.writeUInt16BE(DHCP_SERVER_PORT, 0);
        udp.writeUInt16BE(DHCP_CLIENT_PORT, 2);
        udp.writeUInt16BE(udp.length + reply.length, 4);
        const packet = this._buildIpPacket(gatewayIP, Buffer.from([255, 255, 255, 255]), IP_PROTO_UDP,
            Buffer.concat([udp, reply]));
        const frame = Buffer.allocUnsafe(14 + packet.length);
        if (flags & 0x8000) frame.fill(0xff, 0, 6);
        else chaddr.subarray(0, 6).copy(frame, 0);
        this.gatewayMac.copy(frame, 6);
        frame.writeUInt16BE(ETH_P_IP, 12);
        packet.copy(frame, 14);
        this._queueFrame(frame);
        this.emit('dhcp', messageType === DHCP_OFFER ? 'OFFER' : 'ACK', this.vmIP);
    }
}

module.exports = { NetworkStack };

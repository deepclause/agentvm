const EventEmitter = require('events');

// Protocol Constants
const ETH_P_IP = 0x0800;
const ETH_P_ARP = 0x0806;
const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const IP_PROTO_ICMP = 1;

// DHCP Constants
const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const DHCP_MAGIC_COOKIE = 0x63825363;

// DHCP Message Types
const DHCP_DISCOVER = 1;
const DHCP_OFFER = 2;
const DHCP_REQUEST = 3;
const DHCP_DECLINE = 4;
const DHCP_ACK = 5;
const DHCP_NAK = 6;
const DHCP_RELEASE = 7;

// DHCP Options
const DHCP_OPT_SUBNET_MASK = 1;
const DHCP_OPT_ROUTER = 3;
const DHCP_OPT_DNS = 6;
const DHCP_OPT_HOSTNAME = 12;
const DHCP_OPT_REQUESTED_IP = 50;
const DHCP_OPT_LEASE_TIME = 51;
const DHCP_OPT_MSG_TYPE = 53;
const DHCP_OPT_SERVER_ID = 54;
const DHCP_OPT_END = 255;

class NetworkStack extends EventEmitter {
    constructor(options = {}) {
        super();
        this.gatewayIP = options.gatewayIP || '192.168.127.1';
        this.vmIP = options.vmIP || '192.168.127.3';
        this.gatewayMac = options.gatewayMac || Buffer.from([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
        this.vmMac = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]); // Default VM MAC
        
        this.natTable = new Map(); // key -> { state, mySeq, myAck, ... } for TCP state tracking
        
        // Network I/O is handled by main thread via MessagePort
        this.netPort = options.netPort || null;
        
        // QEMU Framing Buffer
        this.txBuffer = Buffer.alloc(0); // Data sending TO the VM (queued)
        this.rxBuffer = Buffer.alloc(0); // Data received FROM the VM (buffering for full frame)
        
        // TCP Flow Control: Maximum buffer before requesting pause
        // Use larger buffers to reduce pause/resume cycle frequency and improve throughput
        this.TX_BUFFER_HIGH_WATER = 256 * 1024;  // 256KB - request pause
        this.TX_BUFFER_LOW_WATER = 64 * 1024;    // 64KB - request resume
        this.txPaused = new Set(); // Set of TCP session keys that are paused
    }
    
    /**
     * Poll for network responses from main thread (synchronous)
     * Call this during poll_oneoff to check for incoming data
     */
    pollNetResponses() {
        if (!this.netPort) return;
        
        const { receiveMessageOnPort } = require('node:worker_threads');
        
        // Process more bytes per poll to improve throughput
        // The limit prevents runaway processing but should be large enough for sustained transfers
        const MAX_BYTES_PER_POLL = 512 * 1024; // 512KB max per poll cycle
        let bytesThisPoll = 0;
        
        // Check for pending messages
        let msg;
        while ((msg = receiveMessageOnPort(this.netPort))) {
            const m = msg.message;
            if (m.type === 'udp-recv') {
                this._handleUdpResponse(m);
            } else if (m.type === 'tcp-connected') {
                this._handleTcpConnected(m);
            } else if (m.type === 'tcp-data') {
                this._handleTcpData(m);
                bytesThisPoll += m.data.length;
                // Stop processing data if we've hit the limit - leave rest for next poll
                if (bytesThisPoll >= MAX_BYTES_PER_POLL) {
                    break;
                }
            } else if (m.type === 'tcp-end') {
                this._handleTcpEnd(m);
            } else if (m.type === 'tcp-error') {
                this._handleTcpError(m);
            } else if (m.type === 'tcp-close') {
                this._handleTcpClosed(m);
            }
        }
    }
    
    /**
     * Handle UDP response from main thread
     * @private
     */
    _handleUdpResponse(msg) {
        const { data, srcIP, srcPort, dstIP, dstPort } = msg;
        
        // Build UDP response packet
        const udpHeader = Buffer.alloc(8);
        udpHeader.writeUInt16BE(dstPort, 0); // src port (from external server)
        udpHeader.writeUInt16BE(srcPort, 2); // dst port (back to VM)
        udpHeader.writeUInt16BE(8 + data.length, 4); // length
        udpHeader.writeUInt16BE(0, 6); // checksum (optional)
        
        const payload = Buffer.concat([udpHeader, Buffer.from(data)]);
        
        // Send IP packet back to VM
        const dstIPBuf = Buffer.from(dstIP.split('.').map(Number));
        const srcIPBuf = Buffer.from(srcIP.split('.').map(Number));
        
        this.sendIP(payload, IP_PROTO_UDP, dstIPBuf, srcIPBuf);
    }
    
    /**
     * Handle TCP connected event from main thread
     * @private
     */
    _handleTcpConnected(msg) {
        const { key } = msg;
        const session = this.natTable.get(key);
        if (!session) return;
        
        session.state = 'ESTABLISHED';
        // Send SYN-ACK to VM
        this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort, 
                     session.mySeq, session.myAck, 0x12); // SYN | ACK
        session.mySeq++;
    }
    
    /**
     * Handle TCP data from main thread
     * @private
     */
    _handleTcpData(msg) {
        const { key, data } = msg;
        const session = this.natTable.get(key);
        if (!session) return;
        
        const payload = Buffer.from(data);
        
        // MTU is 1500, IP header is 20, TCP header is 20
        // Maximum Segment Size (MSS) = 1500 - 20 - 20 = 1460
        const MSS = 1460;
        
        // Segment the data if it exceeds MSS
        let offset = 0;
        while (offset < payload.length) {
            const chunkSize = Math.min(MSS, payload.length - offset);
            const chunk = payload.subarray(offset, offset + chunkSize);
            const isLast = (offset + chunkSize >= payload.length);
            
            // Send PSH-ACK for last segment, just ACK for intermediate segments
            const flags = isLast ? 0x18 : 0x10; // PSH|ACK or just ACK
            this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort,
                         session.mySeq, session.myAck, flags, chunk);
            session.mySeq += chunk.length;
            offset += chunkSize;
        }
        
        // Flow control: pause main thread socket if buffer is too full
        if (this.txBuffer.length > this.TX_BUFFER_HIGH_WATER && !this.txPaused.has(key)) {
            this.txPaused.add(key);
            this.emit('debug', `[TCP] Pausing ${key}, txBuffer=${this.txBuffer.length}`);
            if (this.netPort) {
                this.netPort.postMessage({ type: 'tcp-pause', key });
            }
        }
    }
    
    /**
     * Handle TCP end (FIN from remote) from main thread
     * @private
     */
    _handleTcpEnd(msg) {
        const { key } = msg;
        const session = this.natTable.get(key);
        if (!session) {
            this.emit('debug', `[TCP] FIN received for unknown session ${key}`);
            return;
        }
        
        this.emit('debug', `[TCP] FIN received for ${key}, state=${session.state}, txBuffer=${this.txBuffer.length}, mySeq=${session.mySeq}, myAck=${session.myAck}`);
        
        // Send FIN-ACK to VM
        this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort,
                     session.mySeq, session.myAck, 0x11); // FIN | ACK
        session.mySeq++;
        session.state = 'FIN_WAIT';
    }
    
    /**
     * Handle TCP error from main thread
     * @private
     */
    _handleTcpError(msg) {
        const { key } = msg;
        const session = this.natTable.get(key);
        if (!session) return;
        
        // Send RST to VM
        this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort,
                     session.mySeq, session.myAck, 0x04); // RST
        this.natTable.delete(key);
    }
    
    /**
     * Handle TCP connection closed from main thread
     * @private
     */
    _handleTcpClosed(msg) {
        const { key } = msg;
        const session = this.natTable.get(key);
        if (session) {
            // Mark session as closing - don't delete yet
            // Wait for VM to send FIN before full cleanup
            session.state = 'CLOSED_BY_REMOTE';
        }
    }

    // Called when VM writes data to the network interface (FD 3)
    // We need to unwrap QEMU framing (4-byte len) -> Frame
    writeToNetwork(data) {
        this.rxBuffer = Buffer.concat([this.rxBuffer, data]);
        
        while (this.rxBuffer.length >= 4) {
            const frameLen = this.rxBuffer.readUInt32BE(0);
            if (this.rxBuffer.length < 4 + frameLen) {
                break; // Wait for more data
            }
            
            const frame = this.rxBuffer.subarray(4, 4 + frameLen);
            this.receive(frame); // Process the frame
            
            this.rxBuffer = this.rxBuffer.subarray(4 + frameLen);
        }
    }

    // Called when VM wants to read data from the network interface
    readFromNetwork(maxLen) {
        if (this.txBuffer.length === 0) return null;
        
        const chunk = this.txBuffer.subarray(0, maxLen);
        this.txBuffer = this.txBuffer.subarray(chunk.length);
        
        // Flow control: resume paused TCP sessions when buffer drains below low water mark
        // This is critical for maintaining throughput - we need to resume quickly
        if (this.txBuffer.length < this.TX_BUFFER_LOW_WATER && this.txPaused.size > 0) {
            this.emit('debug', `[TCP] Resuming ${this.txPaused.size} sessions, txBuffer=${this.txBuffer.length}`);
            for (const key of this.txPaused) {
                if (this.netPort) {
                    this.netPort.postMessage({ type: 'tcp-resume', key });
                }
            }
            this.txPaused.clear();
        }
        
        return chunk;
    }
    
    /**
     * Get the current size of pending data in the TX buffer
     * @returns {number} Number of bytes waiting to be read
     */
    pendingDataSize() {
        return this.txBuffer.length;
    }
    
    /**
     * Close the active socket - send FIN to remote, notify main thread
     */
    closeSocket() {
        // Find the active TCP session (the one that's in FIN_WAIT or ESTABLISHED)
        for (const [key, session] of this.natTable) {
            if (session.state === 'ESTABLISHED' || session.state === 'FIN_WAIT') {
                this.emit('debug', `[TCP] VM closing socket ${key}, state=${session.state}, sending FIN`);
                
                // If we already received FIN from remote (FIN_WAIT), just send ACK
                // Otherwise send FIN to initiate close from our side
                if (session.state === 'FIN_WAIT') {
                    // We already sent FIN-ACK when we received their FIN
                    // Now just clean up - notify main thread to close the socket
                    if (this.netPort) {
                        this.netPort.postMessage({ type: 'tcp-close', key });
                    }
                } else {
                    // ESTABLISHED - we're initiating close, send FIN
                    this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort,
                                 session.mySeq, session.myAck, 0x11); // FIN | ACK
                    session.mySeq++;
                    
                    // Notify main thread to close the socket
                    if (this.netPort) {
                        this.netPort.postMessage({ type: 'tcp-close', key });
                    }
                }
                // Delete the session to allow new connections
                this.natTable.delete(key);
                break; // Only close one socket (we only support one connection at a time currently)
            }
        }
        
        // Also clean up any stale closed sessions
        for (const [key, session] of this.natTable) {
            if (session.state === 'CLOSED_BY_REMOTE' || session.state === 'CLOSED' || session.state === 'FIN_SENT') {
                this.emit('debug', `[TCP] Cleaning up stale session ${key}, state=${session.state}`);
                this.natTable.delete(key);
            }
        }
    }
    
    hasPendingData() {
        return this.txBuffer.length > 0;
    }
    
    /**
     * Check if any TCP session has received FIN (for EOF signaling)
     * @returns {boolean}
     */
    hasReceivedFin() {
        for (const [key, session] of this.natTable) {
            if (session.state === 'FIN_WAIT' || session.state === 'CLOSED_BY_REMOTE') {
                return true;
            }
        }
        return false;
    }

    // Called internally when we want to send a frame TO the VM
    send(payload, proto) {
        if (!this.vmMac) return; 
        
        const frame = Buffer.alloc(14 + payload.length);
        this.vmMac.copy(frame, 0); 
        this.gatewayMac.copy(frame, 6); 
        frame.writeUInt16BE(proto, 12);
        payload.copy(frame, 14);
        
        // Wrap in QEMU framing
        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        
        this.emit('tx', frame); // For testing/debug
        this.emit('network-activity'); // Notify worker to wake up poll
    }
    
    // Send to broadcast MAC (for DHCP etc)
    sendBroadcast(payload, proto) {
        const broadcastMac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        
        const frame = Buffer.alloc(14 + payload.length);
        broadcastMac.copy(frame, 0); // Destination: broadcast
        this.gatewayMac.copy(frame, 6); // Source: gateway MAC
        frame.writeUInt16BE(proto, 12);
        payload.copy(frame, 14);
        
        // Wrap in QEMU framing
        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        
        this.emit('network-activity');
    }

    receive(frame) {
        try {
            if (frame.length < 14) return;
            const etherType = frame.readUInt16BE(12);
            const payload = frame.subarray(14);
            
            // Learn VM MAC
            const srcMac = frame.subarray(6, 12);
            if (!this.vmMac) {
                 this.vmMac = Buffer.from(srcMac);
            }

            if (etherType === ETH_P_ARP) {
                this.handleARP(payload);
            } else if (etherType === ETH_P_IP) {
                this.handleIP(payload);
            }
        } catch(err) {
            this.emit('error', err);
        }
    }

    handleARP(packet) {
        // Simple ARP Reply
        // Hardware Type (2), Protocol (2), HLen (1), PLen (1), Op (2)
        const op = packet.readUInt16BE(6);
        if (op === 1) { // Request
            // Target IP
            const targetIP = packet.subarray(24, 28);
            const targetIPStr = targetIP.join('.');
            
            if (targetIPStr === this.gatewayIP) {
                // Reply
                const reply = Buffer.alloc(28);
                packet.copy(reply, 0, 0, 8); // Copy HW/Proto/Len
                reply.writeUInt16BE(2, 6); // Reply Op
                
                this.gatewayMac.copy(reply, 8); // Sender HW
                targetIP.copy(reply, 14); // Sender IP (Gateway)
                
                packet.subarray(8, 14).copy(reply, 18); // Target HW (VM)
                packet.subarray(14, 18).copy(reply, 24); // Target IP (VM)
                
                this.send(reply, ETH_P_ARP);
            }
        }
    }

    handleIP(packet) {
        const version = packet[0] >> 4;
        if (version !== 4) return;
        
        const headerLen = (packet[0] & 0x0F) * 4;
        const totalLen = packet.readUInt16BE(2);
        const protocol = packet[9];
        const srcIP = packet.subarray(12, 16);
        const dstIP = packet.subarray(16, 20);
        
        const data = packet.subarray(headerLen, totalLen); // strict length?
        
        // this.emit('debug', `[IP] proto=${protocol} src=${srcIP.join('.')} dst=${dstIP.join('.')} len=${data.length}`);

        if (protocol === IP_PROTO_ICMP) {
             this.handleICMP(data, srcIP, dstIP, packet.subarray(0, headerLen));
        } else if (protocol === IP_PROTO_TCP) {
             this.handleTCP(data, srcIP, dstIP, packet);
        } else if (protocol === IP_PROTO_UDP) {
             this.handleUDP(data, srcIP, dstIP);
        }
    }
    
    // Checksum Helpers
    calculateChecksum(buf) {
        let sum = 0;
        for (let i = 0; i < buf.length - 1; i += 2) {
            sum += buf.readUInt16BE(i);
        }
        if (buf.length % 2 === 1) {
            sum += (buf[buf.length - 1] << 8);
        }
        while (sum >> 16) {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return ~sum & 0xFFFF;
    }

    handleICMP(data, srcIP, dstIP, ipHeader) {
        const type = data[0];
        if (type === 8) { // Echo Request
             // Reply
             const reply = Buffer.alloc(data.length);
             data.copy(reply);
             reply[0] = 0; // Echo Reply
             reply[2] = 0; reply[3] = 0; // Clear checksum
             
             const ck = this.calculateChecksum(reply);
             reply.writeUInt16BE(ck, 2);
             
             this.sendIP(reply, IP_PROTO_ICMP, dstIP, srcIP);
        }
    }

    sendIP(payload, protocol, srcIP, dstIP) {
        const header = Buffer.alloc(20);
        header[0] = 0x45; // v4, 5 words
        header[1] = 0; // TOS
        header.writeUInt16BE(20 + payload.length, 2);
        header.writeUInt16BE(0, 4); // ID
        header.writeUInt16BE(0, 6); // Flags/Offset
        header[8] = 64; // TTL
        header[9] = protocol;
        srcIP.copy(header, 12);
        dstIP.copy(header, 16);
        
        // IP Checksum
        header.writeUInt16BE(this.calculateChecksum(header), 10);
        
        const packet = Buffer.concat([header, payload]);
        
        // Check if destination is broadcast
        if (dstIP[0] === 255 && dstIP[1] === 255 && dstIP[2] === 255 && dstIP[3] === 255) {
            this.sendBroadcast(packet, ETH_P_IP);
        } else {
            this.send(packet, ETH_P_IP);
        }
    }
    
    handleTCP(segment, srcIP, dstIP, fullIPPacket) {
        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const seq = segment.readUInt32BE(4);
        const ack = segment.readUInt32BE(8);
        const offset = (segment[12] >> 4) * 4;
        const flags = segment[13];
        const payload = segment.subarray(offset);
        
        const SYN = (flags & 0x02) !== 0;
        const ACK = (flags & 0x10) !== 0;
        const PSH = (flags & 0x08) !== 0;
        const FIN = (flags & 0x01) !== 0;
        const RST = (flags & 0x04) !== 0;

        const key = `TCP:${srcIP.join('.')}:${srcPort}:${dstIP.join('.')}:${dstPort}`;
        let session = this.natTable.get(key);

        if (RST) {
            if (session) {
                // Tell main thread to destroy the socket
                if (this.netPort) {
                    this.netPort.postMessage({ type: 'tcp-close', key, destroy: true });
                }
                this.natTable.delete(key);
            }
            return;
        }

        if (SYN && !session) {
            // New Connection - create session state and tell main thread to connect
            session = { 
                state: 'SYN_SENT', 
                srcIP: Buffer.from(srcIP),
                srcPort,
                dstIP: Buffer.from(dstIP),
                dstPort,
                vmSeq: seq, 
                vmAck: ack,
                mySeq: Math.floor(Math.random() * 0xFFFFFFF),
                myAck: seq + 1 
            };
            this.natTable.set(key, session);
            
            // Request connection via main thread
            if (this.netPort) {
                this.netPort.postMessage({
                    type: 'tcp-connect',
                    key,
                    dstIP: dstIP.join('.'),
                    dstPort,
                    srcIP: srcIP.join('.'),
                    srcPort
                });
            }
            return;
        }

        if (!session) {
            // Unknown session, send RST
            if (!SYN) {
                 this.sendTCP(srcIP, srcPort, dstIP, dstPort, 0, seq + (payload.length || 1), 0x04);
            }
            return;
        }

        // Handle Data from VM
        if (payload.length > 0) {
            // Forward data to main thread
            if (this.netPort) {
                this.netPort.postMessage({
                    type: 'tcp-send',
                    key,
                    data: Array.from(payload)
                });
            }
            session.vmSeq += payload.length;
            session.myAck += payload.length;
            // Send ACK back to VM
            this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort, 
                         session.mySeq, session.myAck, 0x10); // ACK
        }
        
        if (FIN) {
            // Tell main thread to close the connection
            this.emit('debug', `[TCP] VM sent FIN for ${key}, state=${session.state}`);
            if (this.netPort && session.state !== 'CLOSED_BY_REMOTE') {
                this.netPort.postMessage({ type: 'tcp-close', key, destroy: false });
            }
            session.myAck++;
            this.sendTCP(session.srcIP, session.srcPort, session.dstIP, session.dstPort,
                         session.mySeq, session.myAck, 0x10); // ACK
            
            // If remote already closed, we can now clean up the session
            if (session.state === 'CLOSED_BY_REMOTE' || session.state === 'FIN_WAIT') {
                this.natTable.delete(key);
            } else {
                session.state = 'FIN_SENT';
            }
        }
    }

    sendTCP(dstIP, dstPort, srcIP, srcPort, seq, ack, flags, payload = Buffer.alloc(0)) {
        // Debug: log outgoing TCP packets
        const flagStr = [];
        if (flags & 0x01) flagStr.push('FIN');
        if (flags & 0x02) flagStr.push('SYN');
        if (flags & 0x04) flagStr.push('RST');
        if (flags & 0x08) flagStr.push('PSH');
        if (flags & 0x10) flagStr.push('ACK');
        this.emit('debug', `[TCP OUT] ${srcIP.join('.')}:${srcPort} -> ${dstIP.join('.')}:${dstPort} [${flagStr.join(',')}] seq=${seq} ack=${ack} len=${payload.length}`);
        
        const header = Buffer.alloc(20);
        header.writeUInt16BE(srcPort, 0);
        header.writeUInt16BE(dstPort, 2);
        header.writeUInt32BE(seq, 4);
        header.writeUInt32BE(ack, 8);
        header[12] = 0x50; // Header len 20
        header[13] = flags;
        header.writeUInt16BE(65535, 14); // Window
        header.writeUInt16BE(0, 16); // Checksum
        header.writeUInt16BE(0, 18); // Urgent
        
        // Pseudo Header for Checksum
        const pseudo = Buffer.alloc(12);
        srcIP.copy(pseudo, 0);
        dstIP.copy(pseudo, 4);
        pseudo[8] = 0;
        pseudo[9] = IP_PROTO_TCP;
        pseudo.writeUInt16BE(20 + payload.length, 10);
        
        const ckData = Buffer.concat([pseudo, header, payload]);
        const ck = this.calculateChecksum(ckData);
        header.writeUInt16BE(ck, 16);
        
        this.sendIP(Buffer.concat([header, payload]), IP_PROTO_TCP, srcIP, dstIP);
    }
    
    handleUDP(segment, srcIP, dstIP) {
        const srcPort = segment.readUInt16BE(0);
        const dstPort = segment.readUInt16BE(2);
        const payload = segment.subarray(8);
        
        // this.emit('debug', `[UDP] ${srcIP.join('.')}:${srcPort} -> ${dstIP.join('.')}:${dstPort} (${payload.length} bytes)`);
        
        // Intercept DHCP: Client sends from port 68 to port 67
        if (srcPort === DHCP_CLIENT_PORT && dstPort === DHCP_SERVER_PORT) {
            this.handleDHCP(payload);
            return;
        }
        
        // Send UDP via main thread (which has access to event loop for async responses)
        if (this.netPort) {
            const key = `UDP:${srcIP.join('.')}:${srcPort}:${dstIP.join('.')}:${dstPort}`;
            // this.emit('debug', `[UDP NAT] Sending ${payload.length} bytes to ${dstIP.join('.')}:${dstPort} via main thread`);
            
            this.netPort.postMessage({
                type: 'udp-send',
                key,
                dstIP: dstIP.join('.'),
                dstPort,
                srcIP: srcIP.join('.'),
                srcPort,
                payload: Array.from(payload)
            });
        }
    }
    
    handleDHCP(data) {
        if (data.length < 240) return; // Minimum DHCP packet size
        
        const op = data[0];
        if (op !== 1) return; // Only handle BOOTREQUEST (1)
        
        const htype = data[1];
        const hlen = data[2];
        const xid = data.readUInt32BE(4); // Transaction ID
        const flags = data.readUInt16BE(10);
        const chaddr = data.subarray(28, 28 + 16); // Client hardware address
        
        // Check magic cookie at offset 236
        const magic = data.readUInt32BE(236);
        if (magic !== DHCP_MAGIC_COOKIE) return;
        
        // Parse options starting at offset 240
        let msgType = 0;
        let requestedIP = null;
        let i = 240;
        while (i < data.length) {
            const opt = data[i];
            if (opt === DHCP_OPT_END) break;
            if (opt === 0) { i++; continue; } // Pad
            
            const len = data[i + 1];
            const optData = data.subarray(i + 2, i + 2 + len);
            
            if (opt === DHCP_OPT_MSG_TYPE && len >= 1) {
                msgType = optData[0];
            } else if (opt === DHCP_OPT_REQUESTED_IP && len >= 4) {
                requestedIP = optData.subarray(0, 4);
            }
            
            i += 2 + len;
        }
        
        if (msgType === DHCP_DISCOVER) {
            this.sendDHCPOffer(xid, chaddr, flags);
        } else if (msgType === DHCP_REQUEST) {
            this.sendDHCPAck(xid, chaddr, flags);
        }
    }
    
    sendDHCPOffer(xid, chaddr, flags) {
        this.sendDHCPReply(DHCP_OFFER, xid, chaddr, flags);
    }
    
    sendDHCPAck(xid, chaddr, flags) {
        this.sendDHCPReply(DHCP_ACK, xid, chaddr, flags);
    }
    
    sendDHCPReply(msgType, xid, chaddr, flags) {
        // Build DHCP reply packet
        const reply = Buffer.alloc(300); // Enough for basic DHCP
        
        reply[0] = 2; // BOOTREPLY
        reply[1] = 1; // Ethernet
        reply[2] = 6; // Hardware address length
        reply[3] = 0; // Hops
        reply.writeUInt32BE(xid, 4); // Transaction ID
        reply.writeUInt16BE(0, 8); // Secs
        reply.writeUInt16BE(flags, 10); // Flags (broadcast if client requested)
        
        // CIAddr (0.0.0.0) - offset 12
        // YIAddr (your/assigned IP) - offset 16
        const vmIPParts = this.vmIP.split('.').map(Number);
        reply[16] = vmIPParts[0];
        reply[17] = vmIPParts[1];
        reply[18] = vmIPParts[2];
        reply[19] = vmIPParts[3];
        
        // SIAddr (server IP) - offset 20
        const gwIPParts = this.gatewayIP.split('.').map(Number);
        reply[20] = gwIPParts[0];
        reply[21] = gwIPParts[1];
        reply[22] = gwIPParts[2];
        reply[23] = gwIPParts[3];
        
        // GIAddr (gateway IP for relay) - offset 24 - leave 0
        
        // CHAddr (client hardware address) - offset 28
        chaddr.copy(reply, 28);
        
        // SName (server name) - offset 44 - leave 0 (64 bytes)
        // File (boot file) - offset 108 - leave 0 (128 bytes)
        
        // Magic cookie at offset 236
        reply.writeUInt32BE(DHCP_MAGIC_COOKIE, 236);
        
        // Options start at offset 240
        let optOffset = 240;
        
        // Option 53: DHCP Message Type
        reply[optOffset++] = DHCP_OPT_MSG_TYPE;
        reply[optOffset++] = 1;
        reply[optOffset++] = msgType;
        
        // Option 54: Server Identifier
        reply[optOffset++] = DHCP_OPT_SERVER_ID;
        reply[optOffset++] = 4;
        reply[optOffset++] = gwIPParts[0];
        reply[optOffset++] = gwIPParts[1];
        reply[optOffset++] = gwIPParts[2];
        reply[optOffset++] = gwIPParts[3];
        
        // Option 51: Lease Time (1 day = 86400 seconds)
        reply[optOffset++] = DHCP_OPT_LEASE_TIME;
        reply[optOffset++] = 4;
        reply.writeUInt32BE(86400, optOffset);
        optOffset += 4;
        
        // Option 1: Subnet Mask
        reply[optOffset++] = DHCP_OPT_SUBNET_MASK;
        reply[optOffset++] = 4;
        reply[optOffset++] = 255;
        reply[optOffset++] = 255;
        reply[optOffset++] = 255;
        reply[optOffset++] = 0;
        
        // Option 3: Router
        reply[optOffset++] = DHCP_OPT_ROUTER;
        reply[optOffset++] = 4;
        reply[optOffset++] = gwIPParts[0];
        reply[optOffset++] = gwIPParts[1];
        reply[optOffset++] = gwIPParts[2];
        reply[optOffset++] = gwIPParts[3];
        
        // Option 6: DNS Server (use 8.8.8.8)
        reply[optOffset++] = DHCP_OPT_DNS;
        reply[optOffset++] = 4;
        reply[optOffset++] = 8;
        reply[optOffset++] = 8;
        reply[optOffset++] = 8;
        reply[optOffset++] = 8;
        
        // Option 28: Broadcast Address
        reply[optOffset++] = 28; // DHCP_OPT_BROADCAST
        reply[optOffset++] = 4;
        reply[optOffset++] = vmIPParts[0];
        reply[optOffset++] = vmIPParts[1];
        reply[optOffset++] = vmIPParts[2];
        reply[optOffset++] = 255; // x.x.x.255 for /24 subnet
        
        // End option
        reply[optOffset++] = DHCP_OPT_END;
        
        // DHCP/BOOTP requires minimum 300 bytes - send the full buffer (already 0-padded)
        const dhcpLen = 300; // Always send 300 bytes
        
        // Build UDP header
        const udpLen = 8 + dhcpLen;
        const udpHeader = Buffer.alloc(8);
        udpHeader.writeUInt16BE(DHCP_SERVER_PORT, 0); // Source port
        udpHeader.writeUInt16BE(DHCP_CLIENT_PORT, 2); // Dest port
        udpHeader.writeUInt16BE(udpLen, 4); // Length
        udpHeader.writeUInt16BE(0, 6); // Checksum (optional for UDP)
        
        const udpPayload = Buffer.concat([udpHeader, reply]); // Send full 300-byte DHCP packet
        
        // Build IP header
        const srcIP = Buffer.from(gwIPParts);
        const dstIP = Buffer.from([255, 255, 255, 255]);
        
        const ipHeader = Buffer.alloc(20);
        ipHeader[0] = 0x45; // v4, 5 words
        ipHeader[1] = 0; // TOS
        ipHeader.writeUInt16BE(20 + udpPayload.length, 2);
        ipHeader.writeUInt16BE(0, 4); // ID
        ipHeader.writeUInt16BE(0, 6); // Flags/Offset
        ipHeader[8] = 64; // TTL
        ipHeader[9] = IP_PROTO_UDP;
        srcIP.copy(ipHeader, 12);
        dstIP.copy(ipHeader, 16);
        ipHeader.writeUInt16BE(this.calculateChecksum(ipHeader), 10);
        
        const ipPacket = Buffer.concat([ipHeader, udpPayload]);
        
        // Build Ethernet frame - use client MAC directly for unicast, or broadcast MAC if flags indicate broadcast
        const dstMac = (flags & 0x8000) ? Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : chaddr.subarray(0, 6);
        
        const frame = Buffer.alloc(14 + ipPacket.length);
        dstMac.copy(frame, 0); // Destination: client MAC or broadcast
        this.gatewayMac.copy(frame, 6); // Source: gateway MAC
        frame.writeUInt16BE(ETH_P_IP, 12);
        ipPacket.copy(frame, 14);
        
        // Wrap in QEMU framing
        const header = Buffer.alloc(4);
        header.writeUInt32BE(frame.length, 0);
        
        this.txBuffer = Buffer.concat([this.txBuffer, header, frame]);
        
        this.emit('network-activity');
        this.emit('dhcp', msgType === DHCP_OFFER ? 'OFFER' : 'ACK', this.vmIP);
    }
}

module.exports = { NetworkStack };
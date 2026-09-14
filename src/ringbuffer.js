/**
 * SharedArrayBuffer-based Ring Buffer for lock-free IPC
 * 
 * This provides high-performance data transfer between main thread and worker
 * using shared memory instead of MessagePort polling.
 * 
 * Buffer Layout:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Int32[0]: IO_READY signal (Atomics.notify when any I/O)     │
 * │ Int32[1]: STDIN_FLAG (0=empty, 1=data ready)                │
 * │ Int32[2]: STDIN_SIZE (bytes of stdin data)                  │
 * │ Int32[3]: NET_HEAD (write position, main thread updates)    │
 * │ Int32[4]: NET_TAIL (read position, worker updates)          │
 * │ Int32[5]: reserved                                          │
 * │ Int32[6]: reserved                                          │
 * │ Int32[7]: reserved                                          │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Bytes 32-4127: STDIN data area (4KB)                        │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Bytes 4128+: Network ring buffer (~256KB)                   │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * Network Message Format in ring buffer:
 * ┌──────────┬──────────┬──────────────────────────────────────┐
 * │ Uint32   │ Uint8    │ Variable length                      │
 * │ length   │ type     │ payload                              │
 * └──────────┴──────────┴──────────────────────────────────────┘
 */

// Index positions in Int32 view
const IO_READY_INDEX = 0;      // Unified I/O signal (stdin OR network)
const STDIN_FLAG_INDEX = 1;    // Stdin data ready flag
const STDIN_SIZE_INDEX = 2;    // Stdin data size
const NET_HEAD_INDEX = 3;      // Network ring buffer head (write position)
const NET_TAIL_INDEX = 4;      // Network ring buffer tail (read position)

// Buffer offsets
const HEADER_SIZE = 32;        // 8 Int32s = 32 bytes
const STDIN_AREA_SIZE = 4096;  // 4KB for stdin
const STDIN_OFFSET = HEADER_SIZE;
const NET_RING_OFFSET = HEADER_SIZE + STDIN_AREA_SIZE;

// Total buffer size: 32 + 4096 + 1MB = ~1MB
const NET_RING_SIZE = 1024 * 1024;  // 1MB ring buffer for larger transfers
const NET_CONTROL_RESERVE = 16 * 1024; // Data cannot starve FIN/error/DNS events
const TOTAL_BUFFER_SIZE = HEADER_SIZE + STDIN_AREA_SIZE + NET_RING_SIZE;

// Network message types
const NET_MSG_TCP_CONNECTED = 1;
const NET_MSG_TCP_DATA = 2;
const NET_MSG_TCP_END = 3;
const NET_MSG_TCP_ERROR = 4;
const NET_MSG_TCP_CLOSE = 5;
const NET_MSG_UDP_RECV = 6;
const NET_MSG_DNS_RESULT = 7;
const NET_MSG_TCP_INCOMING_CONNECT = 8;

/**
 * Ring buffer writer (used by main thread)
 */
class RingBufferWriter {
    constructor(sharedBuffer) {
        this.buffer = sharedBuffer;
        this.int32 = new Int32Array(sharedBuffer);
        this.uint8 = new Uint8Array(sharedBuffer);
        this.dataView = new DataView(sharedBuffer);
    }
    
    /**
     * Get available space in the ring buffer
     */
    availableSpace() {
        const head = Atomics.load(this.int32, NET_HEAD_INDEX);
        const tail = Atomics.load(this.int32, NET_TAIL_INDEX);
        
        if (head >= tail) {
            // Head is ahead of tail: free space is (size - head) + tail - 1
            return (NET_RING_SIZE - head) + tail - 1;
        } else {
            // Tail is ahead: free space is tail - head - 1
            return tail - head - 1;
        }
    }
    
    /**
     * Check if buffer has enough space (non-blocking)
     * @param {number} needed - Bytes needed
     * @returns {boolean}
     */
    hasSpace(needed) {
        return this.availableSpace() >= needed;
    }
    
    /**
     * Signal the worker to wake up and process data
     * Call this when buffer is full to wake the worker to drain it
     */
    signalWorker() {
        Atomics.add(this.int32, IO_READY_INDEX, 1);
        Atomics.notify(this.int32, IO_READY_INDEX);
    }
    
    _writeRingBytes(position, bytes) {
        const firstLength = Math.min(bytes.length, NET_RING_SIZE - position);
        this.uint8.set(bytes.subarray(0, firstLength), NET_RING_OFFSET + position);
        const remaining = bytes.length - firstLength;
        if (remaining > 0) this.uint8.set(bytes.subarray(firstLength), NET_RING_OFFSET);
        return (position + bytes.length) % NET_RING_SIZE;
    }

    /**
     * Write a network message to the ring buffer
     * @param {number} type - Message type (NET_MSG_*)
     * @param {Uint8Array|Buffer} payload - Message payload
     * @returns {boolean} - True if written, false if no space
     */
    writeMessage(type, payload) {
        const msgLen = 5 + payload.length; // 4 bytes length + 1 byte type + payload
        if (msgLen >= NET_RING_SIZE || this.availableSpace() < msgLen) {
            return false;
        }

        const header = Buffer.allocUnsafe(5);
        header.writeUInt32LE(payload.length, 0);
        header[4] = type;
        let head = Atomics.load(this.int32, NET_HEAD_INDEX);
        head = this._writeRingBytes(head, header);
        head = this._writeRingBytes(head, payload);

        // Publish only after both bulk copies are complete.
        Atomics.store(this.int32, NET_HEAD_INDEX, head);
        Atomics.add(this.int32, IO_READY_INDEX, 1);
        Atomics.notify(this.int32, IO_READY_INDEX);
        
        return true;
    }
    
    /**
     * Write TCP connected event
     * @param {string} key - TCP session key
     */
    writeTcpConnected(key) {
        const keyBytes = Buffer.from(key, 'utf8');
        return this.writeMessage(NET_MSG_TCP_CONNECTED, keyBytes);
    }
    
    /**
     * Write TCP data - writes as much as will fit, returns amount written
     * @param {string} key - TCP session key
     * @param {Uint8Array|Buffer} data - TCP payload
     * @param {number} offset - Start offset in data (default 0)
     * @returns {number} - Number of bytes written (0 if buffer full)
     */
    writeTcpData(key, data, offset = 0) {
        // Format: keyLen(1) + key + data
        const keyBytes = Buffer.from(key, 'utf8');
        
        // Max payload size is 65535 - 1 (keyLen) - keyBytes.length
        // Use 60000 as safe chunk size to leave room for header
        const maxDataPerChunk = 60000;
        if (keyBytes.length > 255) return 0;
        
        let bytesWritten = 0;
        
        while (offset + bytesWritten < data.length) {
            const remaining = data.length - offset - bytesWritten;
            const chunkSize = Math.min(maxDataPerChunk, remaining);
            const payloadSize = 1 + keyBytes.length + chunkSize;
            const msgSize = 5 + payloadSize;
            
            // Leave room for connection state, DNS, and UDP messages. Without
            // this reserve a full data ring can permanently lose TCP END.
            if (!this.hasSpace(msgSize + NET_CONTROL_RESERVE)) {
                break; // No space, return what we've written so far
            }
            
            const payload = Buffer.alloc(payloadSize);
            payload[0] = keyBytes.length;
            keyBytes.copy(payload, 1);
            
            const srcOffset = offset + bytesWritten;
            if (Buffer.isBuffer(data)) {
                data.copy(payload, 1 + keyBytes.length, srcOffset, srcOffset + chunkSize);
            } else {
                payload.set(data.subarray(srcOffset, srcOffset + chunkSize), 1 + keyBytes.length);
            }
            
            this.writeMessage(NET_MSG_TCP_DATA, payload);
            bytesWritten += chunkSize;
        }
        
        return bytesWritten;
    }
    
    /**
     * Write TCP end event
     * @param {string} key - TCP session key
     */
    writeTcpEnd(key) {
        const keyBytes = Buffer.from(key, 'utf8');
        return this.writeMessage(NET_MSG_TCP_END, keyBytes);
    }
    
    /**
     * Write TCP error event
     * @param {string} key - TCP session key
     * @param {string} error - Error message
     */
    writeTcpError(key, error) {
        const keyBytes = Buffer.from(key, 'utf8');
        const errorBytes = Buffer.from(error, 'utf8');
        const payload = Buffer.alloc(1 + keyBytes.length + errorBytes.length);
        payload[0] = keyBytes.length;
        keyBytes.copy(payload, 1);
        errorBytes.copy(payload, 1 + keyBytes.length);
        return this.writeMessage(NET_MSG_TCP_ERROR, payload);
    }
    
    /**
     * Write TCP close event
     * @param {string} key - TCP session key
     */
    writeTcpClose(key) {
        const keyBytes = Buffer.from(key, 'utf8');
        return this.writeMessage(NET_MSG_TCP_CLOSE, keyBytes);
    }
    
    /**
     * Write a DNS lookup result
     * @param {Object} msg - { key, name, qtype, ips, error }
     */
    writeDnsResult(msg) {
        const keyB = Buffer.from(String(msg.key || ''), 'utf8');
        const nameB = Buffer.from(String(msg.name || ''), 'utf8');
        const errB = Buffer.from(String(msg.error || ''), 'utf8');
        const ipList = (msg.ips || []).map((ip) => String(ip));
        let ipBytes = 0;
        for (const ip of ipList) ipBytes += 2 + Buffer.byteLength(ip);

        const payload = Buffer.alloc(
            1 + keyB.length +
            1 + nameB.length +
            2 +
            1 + (msg.error ? 1 + errB.length : 0) +
            1 + ipBytes
        );
        let o = 0;
        payload[o++] = keyB.length; keyB.copy(payload, o); o += keyB.length;
        payload[o++] = nameB.length; nameB.copy(payload, o); o += nameB.length;
        payload.writeUInt16LE(msg.qtype || 0, o); o += 2;
        payload[o++] = msg.error ? 1 : 0;
        if (msg.error) { payload[o++] = errB.length; errB.copy(payload, o); o += errB.length; }
        payload[o++] = ipList.length;
        for (const ip of ipList) {
            const family = ip.includes(':') ? 6 : 4;
            const b = Buffer.from(ip, 'utf8');
            payload[o++] = family;
            payload[o++] = b.length;
            b.copy(payload, o); o += b.length;
        }
        return this.writeMessage(NET_MSG_DNS_RESULT, payload);
    }

    /**
     * Write an inbound (port-forwarded) TCP connection request.
     * @param {Object} msg - { key, guestHost, guestPort, srcPort }
     */
    writeTcpIncomingConnect(msg) {
        // Format: keyLen(1) + key + guestHostLen(1) + guestHost
        //         + guestPort(2) + srcPort(2)
        const keyBytes = Buffer.from(String(msg.key || ''), 'utf8');
        const hostBytes = Buffer.from(String(msg.guestHost || ''), 'utf8');
        if (keyBytes.length > 255 || hostBytes.length > 255) return false;
        const payload = Buffer.alloc(1 + keyBytes.length + 1 + hostBytes.length + 2 + 2);
        let o = 0;
        payload[o++] = keyBytes.length;
        keyBytes.copy(payload, o); o += keyBytes.length;
        payload[o++] = hostBytes.length;
        hostBytes.copy(payload, o); o += hostBytes.length;
        payload.writeUInt16LE(Number(msg.guestPort) || 0, o); o += 2;
        payload.writeUInt16LE(Number(msg.srcPort) || 0, o); o += 2;
        return this.writeMessage(NET_MSG_TCP_INCOMING_CONNECT, payload);
    }

    /**
     * Write a UDP datagram received by an existing NAT flow.
     * @param {Object} msg - { key, data }
     */
    writeUdpRecv(msg) {
        // Format: keyLen(1) + key + data. Endpoint metadata lives in the
        // worker's flow table, which also prevents spoofed reply addresses.
        const keyBytes = Buffer.from(msg.key, 'utf8');
        if (keyBytes.length > 255) return false;
        const dataBytes = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data);
        const payload = Buffer.alloc(1 + keyBytes.length + dataBytes.length);
        payload[0] = keyBytes.length;
        keyBytes.copy(payload, 1);
        dataBytes.copy(payload, 1 + keyBytes.length);
        return this.writeMessage(NET_MSG_UDP_RECV, payload);
    }
    
    /**
     * Write stdin data
     * @param {Uint8Array|Buffer} data - Stdin data
     */
    writeStdin(data) {
        // Wait for previous stdin to be consumed
        while (Atomics.load(this.int32, STDIN_FLAG_INDEX) !== 0) {
            // Busy wait - stdin should be consumed quickly
            Atomics.wait(this.int32, STDIN_FLAG_INDEX, 1, 5);
        }
        
        // Copy data to stdin area
        const len = Math.min(data.length, STDIN_AREA_SIZE);
        this.uint8.set(data.subarray(0, len), STDIN_OFFSET);
        
        // Set size and flag atomically
        Atomics.store(this.int32, STDIN_SIZE_INDEX, len);
        Atomics.store(this.int32, STDIN_FLAG_INDEX, 1);
        
        // Signal I/O ready
        Atomics.add(this.int32, IO_READY_INDEX, 1);
        Atomics.notify(this.int32, IO_READY_INDEX);
        
        return len;
    }
}

/**
 * Ring buffer reader (used by worker thread)
 */
class RingBufferReader {
    constructor(sharedBuffer) {
        this.buffer = sharedBuffer;
        this.int32 = new Int32Array(sharedBuffer);
        this.uint8 = new Uint8Array(sharedBuffer);
    }
    
    /**
     * Check if there's data available in the network ring buffer
     */
    hasNetworkData() {
        const head = Atomics.load(this.int32, NET_HEAD_INDEX);
        const tail = Atomics.load(this.int32, NET_TAIL_INDEX);
        return head !== tail;
    }
    
    /**
     * Check if there's stdin data available
     */
    hasStdinData() {
        return Atomics.load(this.int32, STDIN_FLAG_INDEX) !== 0;
    }
    
    /**
     * Read stdin data (returns null if none available)
     */
    readStdin() {
        if (Atomics.load(this.int32, STDIN_FLAG_INDEX) === 0) {
            return null;
        }
        
        const size = Atomics.load(this.int32, STDIN_SIZE_INDEX);
        const data = this.uint8.slice(STDIN_OFFSET, STDIN_OFFSET + size);
        
        // Clear flag and notify writer
        Atomics.store(this.int32, STDIN_SIZE_INDEX, 0);
        Atomics.store(this.int32, STDIN_FLAG_INDEX, 0);
        Atomics.notify(this.int32, STDIN_FLAG_INDEX);
        
        return data;
    }
    
    /**
     * Read next network message (returns null if none available)
     * @returns {Object|null} - { type, payload } or null
     */
    readNetworkMessage() {
        const head = Atomics.load(this.int32, NET_HEAD_INDEX);
        let tail = Atomics.load(this.int32, NET_TAIL_INDEX);
        
        if (head === tail) {
            return null; // Empty
        }
        
        const ringStart = NET_RING_OFFSET;
        
        // Read length (4 bytes, little-endian)
        let payloadLen = 0;
        for (let shift = 0; shift < 32; shift += 8) {
            payloadLen += this.uint8[ringStart + tail] * (2 ** shift);
            tail = (tail + 1) % NET_RING_SIZE;
        }
        if (payloadLen > NET_RING_SIZE - 6) {
            // Shared-memory corruption: drop queued data instead of allocating
            // an unbounded payload.
            Atomics.store(this.int32, NET_TAIL_INDEX, head);
            return null;
        }
        
        // Read type (1 byte)
        const type = this.uint8[ringStart + tail];
        tail = (tail + 1) % NET_RING_SIZE;
        
        // Copy the payload in at most two operations instead of executing one
        // JavaScript loop iteration per network byte.
        const payload = Buffer.allocUnsafe(payloadLen);
        const firstLength = Math.min(payloadLen, NET_RING_SIZE - tail);
        payload.set(this.uint8.subarray(ringStart + tail, ringStart + tail + firstLength), 0);
        const remaining = payloadLen - firstLength;
        if (remaining > 0) {
            payload.set(this.uint8.subarray(ringStart, ringStart + remaining), firstLength);
        }
        tail = (tail + payloadLen) % NET_RING_SIZE;
        
        // Update tail atomically
        Atomics.store(this.int32, NET_TAIL_INDEX, tail);
        
        return { type, payload };
    }
    
    /**
     * Parse TCP data message
     * @param {Buffer} payload 
     * @returns {Object} - { key, data }
     */
    parseTcpData(payload) {
        const keyLen = payload[0];
        const key = payload.slice(1, 1 + keyLen).toString('utf8');
        const data = payload.slice(1 + keyLen);
        return { key, data };
    }
    
    /**
     * Parse key-only message (connected, end, close)
     * @param {Buffer} payload 
     * @returns {string} - key
     */
    parseKey(payload) {
        return payload.toString('utf8');
    }
    
    /**
     * Parse TCP error message
     * @param {Buffer} payload 
     * @returns {Object} - { key, error }
     */
    parseTcpError(payload) {
        const keyLen = payload[0];
        const key = payload.slice(1, 1 + keyLen).toString('utf8');
        const error = payload.slice(1 + keyLen).toString('utf8');
        return { key, error };
    }
    
    /**
     * Parse DNS result message
     * @param {Buffer} payload
     * @returns {Object} - { key, name, qtype, ips, error }
     */
    parseDnsResult(payload) {
        let o = 0;
        const keyLen = payload[o++];
        const key = payload.slice(o, o + keyLen).toString('utf8'); o += keyLen;
        const nameLen = payload[o++];
        const name = payload.slice(o, o + nameLen).toString('utf8'); o += nameLen;
        const qtype = payload.readUInt16LE(o); o += 2;
        const hasError = payload[o++];
        let error = null;
        if (hasError) {
            const errLen = payload[o++];
            error = payload.slice(o, o + errLen).toString('utf8'); o += errLen;
        }
        const count = payload[o++];
        const ips = [];
        for (let i = 0; i < count; i++) {
            o++; // family (unused by the caller, the IP string is authoritative)
            const ipLen = payload[o++];
            ips.push(payload.slice(o, o + ipLen).toString('utf8')); o += ipLen;
        }
        return { key, name, qtype, ips, error };
    }

    /** Parse an inbound TCP connection request: { key, guestHost, guestPort, srcPort }. */
    parseTcpIncomingConnect(payload) {
        let o = 0;
        const keyLen = payload[o++];
        const key = payload.slice(o, o + keyLen).toString('utf8'); o += keyLen;
        const hostLen = payload[o++];
        const guestHost = payload.slice(o, o + hostLen).toString('utf8'); o += hostLen;
        const guestPort = payload.readUInt16LE(o); o += 2;
        const srcPort = payload.readUInt16LE(o); o += 2;
        return { key, guestHost, guestPort, srcPort };
    }

    /** Parse a UDP receive message: { key, data }. */
    parseUdpRecv(payload) {
        const keyLen = payload[0];
        const key = payload.slice(1, 1 + keyLen).toString('utf8');
        const data = payload.slice(1 + keyLen);
        return { key, data };
    }
    
    /**
     * Wait for any I/O (stdin or network)
     * @param {number} timeout - Timeout in ms (-1 for infinite)
     * @returns {boolean} - True if I/O is available
     */
    waitForIO(timeout) {
        const lastSignal = Atomics.load(this.int32, IO_READY_INDEX);
        
        // Check if already ready
        if (this.hasStdinData() || this.hasNetworkData()) {
            return true;
        }
        
        // Wait for signal
        const t = timeout < 0 ? undefined : timeout;
        const result = Atomics.wait(this.int32, IO_READY_INDEX, lastSignal, t);
        
        return result !== 'timed-out';
    }
    
    /**
     * Get current IO signal value (for external wait coordination)
     */
    getIOSignal() {
        return Atomics.load(this.int32, IO_READY_INDEX);
    }
}

module.exports = {
    RingBufferWriter,
    RingBufferReader,
    TOTAL_BUFFER_SIZE,
    IO_READY_INDEX,
    STDIN_FLAG_INDEX,
    STDIN_SIZE_INDEX,
    NET_HEAD_INDEX,
    NET_TAIL_INDEX,
    STDIN_OFFSET,
    STDIN_AREA_SIZE,
    NET_RING_OFFSET,
    NET_RING_SIZE,
    // Message types
    NET_MSG_TCP_CONNECTED,
    NET_MSG_TCP_DATA,
    NET_MSG_TCP_END,
    NET_MSG_TCP_ERROR,
    NET_MSG_TCP_CLOSE,
    NET_MSG_UDP_RECV,
    NET_MSG_DNS_RESULT,
    NET_MSG_TCP_INCOMING_CONNECT
};

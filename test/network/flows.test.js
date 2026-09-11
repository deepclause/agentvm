const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkStack } = require('../../src/network');
const {
    RingBufferWriter,
    RingBufferReader,
    TOTAL_BUFFER_SIZE,
} = require('../../src/ringbuffer');

const guestIP = Buffer.from([192, 168, 127, 3]);
const remoteIP = Buffer.from([203, 0, 113, 9]);

function tcpSegment({ srcPort = 40000, dstPort = 80, seq, ack = 0, flags, window = 65535, data = Buffer.alloc(0), options = Buffer.alloc(0) }) {
    const optionLength = (options.length + 3) & ~3;
    const segment = Buffer.alloc(20 + optionLength + data.length);
    segment.writeUInt16BE(srcPort, 0);
    segment.writeUInt16BE(dstPort, 2);
    segment.writeUInt32BE(seq >>> 0, 4);
    segment.writeUInt32BE(ack >>> 0, 8);
    segment[12] = ((20 + optionLength) / 4) << 4;
    segment[13] = flags;
    segment.writeUInt16BE(window, 14);
    options.copy(segment, 20);
    data.copy(segment, 20 + optionLength);
    return segment;
}

function drainFrames(stack) {
    const bytes = stack.readFromNetwork(stack.pendingDataSize());
    if (!bytes) return [];
    const frames = [];
    for (let offset = 0; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        frames.push(bytes.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }
    return frames;
}

function tcpPayload(frame) {
    const ip = frame.subarray(14);
    const ipHeaderLength = (ip[0] & 15) * 4;
    const tcp = ip.subarray(ipHeaderLength);
    const tcpHeaderLength = (tcp[12] >>> 4) * 4;
    return tcp.subarray(tcpHeaderLength);
}

function establish(window = 65535) {
    const posted = [];
    const stack = new NetworkStack({ netPort: { postMessage: (message) => posted.push(message) } });
    stack.handleTCP(tcpSegment({
        seq: 1000,
        flags: 0x02,
        window,
        options: Buffer.from([2, 4, 0x05, 0xb4, 3, 3, 0, 1]),
    }), guestIP, remoteIP);
    const flow = [...stack.tcpFlows.values()][0];
    assert.equal(posted[0].type, 'tcp-connect');
    stack._handleTcpConnected(flow.key);
    const synAck = drainFrames(stack);
    assert.equal(synAck.length, 1);
    assert.equal(synAck[0][14 + 20 + 13] & 0x12, 0x12);
    stack.handleTCP(tcpSegment({
        seq: flow.guestNext,
        ack: flow.sendNext,
        flags: 0x10,
        window,
    }), guestIP, remoteIP);
    assert.equal(flow.state, 'ESTABLISHED');
    drainFrames(stack);
    return { stack, flow, posted };
}

test('TCP honors the advertised receive window without overrunning it', () => {
    const { stack, flow } = establish(4);
    stack._handleTcpData({ key: flow.key, data: Buffer.from('abcdefghij') });
    let frames = drainFrames(stack);
    assert.equal(frames.length, 1);
    assert.equal(tcpPayload(frames[0]).toString(), 'abcd');
    assert.equal(flow.pendingBytes, 6);

    stack.handleTCP(tcpSegment({
        seq: flow.guestNext,
        ack: flow.sendNext,
        flags: 0x10,
        window: 4,
    }), guestIP, remoteIP);
    frames = drainFrames(stack);
    assert.equal(tcpPayload(frames[0]).toString(), 'efgh');
    assert.equal(flow.pendingBytes, 2);
});

test('TCP caps a scaled guest window to the virtual NIC flight limit', () => {
    const { stack, flow } = establish(65535);
    // Simulate a negotiated scale factor and a multi-megabyte Linux window.
    flow.windowScale = 7;
    flow.guestWindow = 65535 * 128;
    stack._handleTcpData({ key: flow.key, data: Buffer.alloc(128 * 1024, 0x5a) });
    const bytesSent = drainFrames(stack).reduce((total, frame) => total + tcpPayload(frame).length, 0);
    assert.equal(bytesSent, 32 * 1024);
    assert.equal(flow.pendingBytes, 96 * 1024);
});

test('TCP never forwards duplicate or out-of-order guest bytes twice', () => {
    const { stack, flow, posted } = establish();
    const ack = flow.sendNext;
    const first = tcpSegment({ seq: 1001, ack, flags: 0x18, data: Buffer.from('abc') });
    stack.handleTCP(first, guestIP, remoteIP);
    stack.handleTCP(first, guestIP, remoteIP); // retransmission
    stack.handleTCP(tcpSegment({ seq: 1010, ack, flags: 0x18, data: Buffer.from('bad') }), guestIP, remoteIP);

    const sends = posted.filter((message) => message.type === 'tcp-send');
    assert.equal(sends.length, 1);
    assert.equal(Buffer.from(sends[0].data).toString(), 'abc');
    assert.equal(flow.guestNext, 1004);
});

test('unacknowledged data is retransmitted and excessive loss tears down only that flow', () => {
    const { stack, flow, posted } = establish();
    stack._handleTcpData({ key: flow.key, data: Buffer.from('payload') });
    drainFrames(stack);
    const entry = flow.unacked[0];
    stack.tick(entry.sentAt + flow.retransmitTimeout + 1);
    assert.equal(drainFrames(stack).length, 1);

    for (let i = 0; i < 13 && stack.tcpFlows.has(flow.key); i++) {
        const current = flow.unacked[0];
        stack.tick(current.sentAt + flow.retransmitTimeout + 1);
        drainFrames(stack);
    }
    assert.equal(stack.tcpFlows.has(flow.key), false);
    assert.ok(posted.some((message) => message.type === 'tcp-close' && message.key === flow.key && message.destroy));
});

test('UDP replies use the remote endpoint as source and the guest as destination', () => {
    const posted = [];
    const stack = new NetworkStack({ netPort: { postMessage: (message) => posted.push(message) } });
    const udp = Buffer.alloc(8 + 2);
    udp.writeUInt16BE(41000, 0);
    udp.writeUInt16BE(9000, 2);
    udp.writeUInt16BE(udp.length, 4);
    udp.write('hi', 8);
    stack.handleUDP(udp, guestIP, remoteIP);
    const key = posted[0].key;
    stack._handleUdpResponse({ key, data: Buffer.from('ok') });

    const frame = drainFrames(stack)[0];
    const ip = frame.subarray(14);
    assert.deepEqual([...ip.subarray(12, 16)], [...remoteIP]);
    assert.deepEqual([...ip.subarray(16, 20)], [...guestIP]);
    const response = ip.subarray(20);
    assert.equal(response.readUInt16BE(0), 9000);
    assert.equal(response.readUInt16BE(2), 41000);
    assert.equal(response.subarray(8).toString(), 'ok');
});

test('ring buffer preserves a maximum-size UDP payload and its flow key', () => {
    const shared = new SharedArrayBuffer(TOTAL_BUFFER_SIZE);
    const writer = new RingBufferWriter(shared);
    const reader = new RingBufferReader(shared);
    const data = Buffer.alloc(65507, 0xa5);
    assert.equal(writer.writeUdpRecv({ key: 'UDP:flow', data }), true);
    const message = reader.readNetworkMessage();
    const parsed = reader.parseUdpRecv(message.payload);
    assert.equal(parsed.key, 'UDP:flow');
    assert.equal(parsed.data.length, data.length);
    assert.equal(parsed.data[parsed.data.length - 1], 0xa5);
});

test('malformed frame lengths and truncated protocol packets are safely ignored', () => {
    const stack = new NetworkStack();
    assert.doesNotThrow(() => stack.writeToNetwork(Buffer.from([0xff, 0xff, 0xff, 0xff])));
    assert.doesNotThrow(() => stack.handleARP(Buffer.alloc(2)));
    assert.doesNotThrow(() => stack.handleIP(Buffer.alloc(3)));
    assert.doesNotThrow(() => stack.handleTCP(Buffer.alloc(3), guestIP, remoteIP));
    assert.doesNotThrow(() => stack.handleUDP(Buffer.alloc(3), guestIP, remoteIP));
});

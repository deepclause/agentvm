'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkStack } = require('../../src/network');
const { RingBufferWriter, RingBufferReader, TOTAL_BUFFER_SIZE, NET_MSG_TCP_INCOMING_CONNECT } = require('../../src/ringbuffer');

const guestIP = Buffer.from([192, 168, 127, 3]);
const gatewayIP = Buffer.from([192, 168, 127, 1]);

function tcpSegment({ srcPort, dstPort, seq, ack = 0, flags, window = 65535, data = Buffer.alloc(0), options = Buffer.alloc(0) }) {
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

function tcpFromFrame(frame) {
    const ip = frame.subarray(14);
    const ipHeaderLength = (ip[0] & 15) * 4;
    return ip.subarray(ipHeaderLength);
}

function tcpPayload(frame) {
    const tcp = tcpFromFrame(frame);
    const headerLength = (tcp[12] >>> 4) * 4;
    return tcp.subarray(headerLength);
}

function tcpFlags(frame) {
    return tcpFromFrame(frame)[13];
}

function tcpPorts(frame) {
    const tcp = tcpFromFrame(frame);
    return { srcPort: tcp.readUInt16BE(0), dstPort: tcp.readUInt16BE(2) };
}

test('ring buffer round-trips an inbound TCP connect message', () => {
    const sab = new SharedArrayBuffer(TOTAL_BUFFER_SIZE);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);

    const written = writer.writeTcpIncomingConnect({
        key: 'TCP:192.168.127.3:3000:192.168.127.1:40000',
        guestHost: '192.168.127.3',
        guestPort: 3000,
        srcPort: 40000,
    });
    assert.equal(written, true);

    const message = reader.readNetworkMessage();
    assert.ok(message);
    assert.equal(message.type, NET_MSG_TCP_INCOMING_CONNECT);
    assert.deepEqual(reader.parseTcpIncomingConnect(message.payload), {
        key: 'TCP:192.168.127.3:3000:192.168.127.1:40000',
        guestHost: '192.168.127.3',
        guestPort: 3000,
        srcPort: 40000,
    });
});

test('incoming connect performs an active open and completes with guest SYN-ACK', () => {
    const posted = [];
    const stack = new NetworkStack({ netPort: { postMessage: (message) => posted.push(message) } });
    const key = 'TCP:192.168.127.3:3000:192.168.127.1:40000';

    stack._handleTcpIncomingConnect({ key, guestHost: '192.168.127.3', guestPort: 3000, srcPort: 40000 });
    const flow = stack.tcpFlows.get(key);
    assert.ok(flow);
    assert.equal(flow.activeOpen, true);
    assert.equal(flow.state, 'SYN_SENT');

    const synFrames = drainFrames(stack);
    assert.equal(synFrames.length, 1);
    assert.deepEqual(tcpPorts(synFrames[0]), { srcPort: 40000, dstPort: 3000 });
    assert.equal(tcpFlags(synFrames[0]) & 0x02, 0x02); // SYN

    // Guest replies with SYN-ACK.
    stack.handleTCP(tcpSegment({
        srcPort: 3000,
        dstPort: 40000,
        seq: 5000,
        ack: flow.sendNext,
        flags: 0x12, // SYN | ACK
    }), guestIP, gatewayIP);

    assert.equal(flow.state, 'ESTABLISHED');
    assert.equal(flow.guestNext, 5001);

    // Host data is now forwarded to the guest.
    stack._handleTcpData({ key, data: Buffer.from('hello') });
    const dataFrames = drainFrames(stack).filter((frame) => tcpPayload(frame).length > 0);
    assert.equal(tcpPayload(dataFrames[0]).toString(), 'hello');

    // Guest data is forwarded to the main thread as a tcp-send message.
    stack.handleTCP(tcpSegment({
        srcPort: 3000,
        dstPort: 40000,
        seq: flow.guestNext,
        ack: flow.sendNext,
        flags: 0x18, // PSH | ACK
        data: Buffer.from('world'),
    }), guestIP, gatewayIP);
    const send = posted.find((message) => message.type === 'tcp-send');
    assert.ok(send);
    assert.equal(Buffer.from(send.data).toString(), 'world');
});

test('guest RST to an incoming connect tears down the flow', () => {
    const posted = [];
    const stack = new NetworkStack({ netPort: { postMessage: (message) => posted.push(message) } });
    const key = 'TCP:192.168.127.3:3000:192.168.127.1:40001';

    stack._handleTcpIncomingConnect({ key, guestHost: '192.168.127.3', guestPort: 3000, srcPort: 40001 });
    assert.ok(stack.tcpFlows.has(key));

    stack.handleTCP(tcpSegment({
        srcPort: 3000,
        dstPort: 40001,
        seq: 0,
        ack: 0,
        flags: 0x04, // RST
    }), guestIP, gatewayIP);

    assert.equal(stack.tcpFlows.has(key), false);
    const close = posted.find((message) => message.type === 'tcp-close');
    assert.ok(close);
    assert.equal(close.destroy, true);
});

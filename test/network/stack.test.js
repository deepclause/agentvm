const { NetworkStack } = require('../../src/network');
const assert = require('assert');

/**
 * Unit tests for NetworkStack packet handling
 * Tests protocol parsing and response generation without actual network I/O
 */

console.log("=== NetworkStack Unit Tests ===\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
}

// Helper to create Ethernet frame
function createEthFrame(srcMac, dstMac, etherType, payload) {
    const frame = Buffer.alloc(14 + payload.length);
    dstMac.copy(frame, 0);
    srcMac.copy(frame, 6);
    frame.writeUInt16BE(etherType, 12);
    payload.copy(frame, 14);
    return frame;
}

// Helper to create IP header
function createIPHeader(net, srcIP, dstIP, protocol, payloadLen) {
    const header = Buffer.alloc(20);
    header[0] = 0x45; // Version 4, IHL 5
    header[1] = 0x00; // DSCP/ECN
    header.writeUInt16BE(20 + payloadLen, 2); // Total length
    header.writeUInt16BE(0, 4); // Identification
    header.writeUInt16BE(0x4000, 6); // Flags + Fragment offset (Don't fragment)
    header[8] = 64; // TTL
    header[9] = protocol; // Protocol
    header.writeUInt16BE(0, 10); // Checksum (calculate after)
    Buffer.from(srcIP.split('.').map(Number)).copy(header, 12);
    Buffer.from(dstIP.split('.').map(Number)).copy(header, 16);
    
    // Calculate checksum
    const checksum = net.calculateChecksum(header);
    header.writeUInt16BE(checksum, 10);
    
    return header;
}

const vmMac = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
const gatewayMac = Buffer.from([0x5a, 0x94, 0xef, 0xe4, 0x0c, 0xdd]);
const broadcastMac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

// ==== ARP Tests ====

test("ARP Request for gateway IP returns ARP Reply", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    // Build ARP Request for 192.168.127.1 (gateway)
    const arp = Buffer.alloc(28);
    arp.writeUInt16BE(1, 0);       // Hardware type: Ethernet
    arp.writeUInt16BE(0x0800, 2);  // Protocol type: IPv4
    arp[4] = 6;                     // Hardware size
    arp[5] = 4;                     // Protocol size
    arp.writeUInt16BE(1, 6);       // Operation: Request
    vmMac.copy(arp, 8);            // Sender MAC
    Buffer.from([192, 168, 127, 3]).copy(arp, 14);  // Sender IP
    Buffer.from([0, 0, 0, 0, 0, 0]).copy(arp, 18);  // Target MAC (unknown)
    Buffer.from([192, 168, 127, 1]).copy(arp, 24);  // Target IP (gateway)
    
    const frame = createEthFrame(vmMac, broadcastMac, 0x0806, arp);
    net.receive(frame);
    
    assert.strictEqual(messages.length, 1, "Should send one reply");
    const reply = messages[0];
    assert.strictEqual(reply.readUInt16BE(12), 0x0806, "Reply should be ARP");
    
    const replyArp = reply.subarray(14);
    assert.strictEqual(replyArp.readUInt16BE(6), 2, "Should be ARP Reply (op=2)");
    
    // Verify sender MAC in reply is gateway MAC
    const senderMac = replyArp.subarray(8, 14);
    assert.ok(senderMac.equals(gatewayMac), "Sender MAC should be gateway MAC");
});

test("ARP Request for non-gateway IP is ignored", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    // Build ARP Request for 192.168.127.5 (not gateway)
    const arp = Buffer.alloc(28);
    arp.writeUInt16BE(1, 0);
    arp.writeUInt16BE(0x0800, 2);
    arp[4] = 6; arp[5] = 4;
    arp.writeUInt16BE(1, 6);
    vmMac.copy(arp, 8);
    Buffer.from([192, 168, 127, 3]).copy(arp, 14);
    Buffer.from([0, 0, 0, 0, 0, 0]).copy(arp, 18);
    Buffer.from([192, 168, 127, 5]).copy(arp, 24);  // Different IP
    
    const frame = createEthFrame(vmMac, broadcastMac, 0x0806, arp);
    net.receive(frame);
    
    assert.strictEqual(messages.length, 0, "Should not reply to non-gateway ARP");
});

// ==== ICMP Tests ====

test("ICMP Echo Request returns Echo Reply", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    // Build ICMP Echo Request
    const icmp = Buffer.alloc(8);
    icmp[0] = 8;  // Type: Echo Request
    icmp[1] = 0;  // Code
    icmp.writeUInt16BE(0, 2);  // Checksum (will recalculate)
    icmp.writeUInt16BE(1, 4);  // Identifier
    icmp.writeUInt16BE(1, 6);  // Sequence
    
    // Calculate ICMP checksum
    const cksum = net.calculateChecksum(icmp);
    icmp.writeUInt16BE(cksum, 2);
    
    const ipHeader = createIPHeader(net, '192.168.127.3', '192.168.127.1', 1, icmp.length);
    const ipPacket = Buffer.concat([ipHeader, icmp]);
    const frame = createEthFrame(vmMac, gatewayMac, 0x0800, ipPacket);
    
    net.receive(frame);
    
    assert.strictEqual(messages.length, 1, "Should send one reply");
    const reply = messages[0];
    
    // Parse reply
    const replyIP = reply.subarray(14);
    assert.strictEqual(replyIP[9], 1, "Protocol should be ICMP");
    
    const replyICMP = replyIP.subarray(20);
    assert.strictEqual(replyICMP[0], 0, "Should be Echo Reply (type=0)");
});

test("ICMP checksum is correctly calculated", () => {
    const net = new NetworkStack();
    
    // Simple test data
    const data = Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]);
    data.writeUInt16BE(0, 2); // Clear checksum field
    const checksum = net.calculateChecksum(data);
    
    // Verify checksum
    data.writeUInt16BE(checksum, 2);
    const verify = net.calculateChecksum(data);
    assert.strictEqual(verify, 0, "Checksum verification should be 0");
});

// ==== IP Tests ====

test("IP checksum calculation", () => {
    const net = new NetworkStack();
    
    const header = Buffer.alloc(20);
    header[0] = 0x45;
    header.writeUInt16BE(40, 2);
    header[8] = 64;
    header[9] = 6;
    Buffer.from([192, 168, 127, 3]).copy(header, 12);
    Buffer.from([93, 184, 216, 34]).copy(header, 16);
    
    const checksum = net.calculateChecksum(header);
    header.writeUInt16BE(checksum, 10);
    
    const verify = net.calculateChecksum(header);
    assert.strictEqual(verify, 0, "IP header checksum should verify to 0");
});

test("Invalid IP version is ignored", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    // Build IPv6-like header (version 6)
    const ipPacket = Buffer.alloc(40);
    ipPacket[0] = 0x60;  // Version 6
    
    const frame = createEthFrame(vmMac, gatewayMac, 0x0800, ipPacket);
    net.receive(frame);
    
    assert.strictEqual(messages.length, 0, "Should ignore non-IPv4 packets");
});

// ==== Frame Tests ====

test("Too short frame is ignored", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    const shortFrame = Buffer.alloc(10);  // Less than 14 bytes
    net.receive(shortFrame);
    
    assert.strictEqual(messages.length, 0, "Should ignore short frames");
});

test("VM MAC is learned from received frame", () => {
    const net = new NetworkStack();
    const customMac = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    
    // Build any valid frame
    const arp = Buffer.alloc(28);
    arp.writeUInt16BE(1, 0);
    arp.writeUInt16BE(0x0800, 2);
    arp[4] = 6; arp[5] = 4;
    arp.writeUInt16BE(1, 6);
    customMac.copy(arp, 8);
    Buffer.from([192, 168, 127, 3]).copy(arp, 14);
    Buffer.from([0, 0, 0, 0, 0, 0]).copy(arp, 18);
    Buffer.from([192, 168, 127, 1]).copy(arp, 24);
    
    const frame = createEthFrame(customMac, broadcastMac, 0x0806, arp);
    
    // Clear existing vmMac
    net.vmMac = null;
    net.receive(frame);
    
    assert.ok(net.vmMac.equals(customMac), "VM MAC should be learned from frame");
});

// ==== Buffer Management Tests ====

test("send() creates properly framed packet", () => {
    const net = new NetworkStack();
    
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    net.send(payload, 0x0800);
    
    assert.ok(net.hasPendingData(), "Should have pending data");
    
    // Read the framed data using readFromNetwork
    const frameWithHeader = net.readFromNetwork(1000);
    
    // First 4 bytes are QEMU frame length
    const frameLen = frameWithHeader.readUInt32BE(0);
    assert.strictEqual(frameLen, 14 + payload.length, "Frame length should be Eth header + payload");
    
    // Ethernet frame starts after length header
    const etherType = frameWithHeader.readUInt16BE(4 + 12);
    assert.strictEqual(etherType, 0x0800, "EtherType should be IPv4");
});

test("writeToNetwork() processes QEMU-framed data correctly", () => {
    const net = new NetworkStack();
    const messages = [];
    net.on('tx', (frame) => messages.push(frame));
    
    // Build ARP request with QEMU framing
    const arp = Buffer.alloc(28);
    arp.writeUInt16BE(1, 0);
    arp.writeUInt16BE(0x0800, 2);
    arp[4] = 6; arp[5] = 4;
    arp.writeUInt16BE(1, 6);
    vmMac.copy(arp, 8);
    Buffer.from([192, 168, 127, 3]).copy(arp, 14);
    Buffer.from([0, 0, 0, 0, 0, 0]).copy(arp, 18);
    Buffer.from([192, 168, 127, 1]).copy(arp, 24);
    
    const frame = createEthFrame(vmMac, broadcastMac, 0x0806, arp);
    
    // Add QEMU framing
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length, 0);
    const framedData = Buffer.concat([header, frame]);
    
    net.writeToNetwork(framedData);
    
    assert.strictEqual(messages.length, 1, "Should process framed packet");
});

// ==== Summary ====

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
    process.exit(1);
}

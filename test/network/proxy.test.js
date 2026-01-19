const { NetworkStack } = require('../../src/network');
const assert = require('assert');

// Simple test to verify Packet parsing and ARP response
const net = new NetworkStack();
const messages = [];
net.on('tx', (frame) => messages.push(frame));

console.log("Testing ARP...");
// Construct ARP Request
// Eth Header (14)
const eth = Buffer.alloc(14);
eth.writeUInt16BE(0x0806, 12); // ARP
Buffer.from([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]).copy(eth, 0); // Broadcast
Buffer.from([0x02,0x00,0x00,0x00,0x00,0x01]).copy(eth, 6); // VM MAC

// ARP Payload
const arp = Buffer.alloc(28);
arp.writeUInt16BE(1, 0); // HW Eth
arp.writeUInt16BE(0x0800, 2); // Proto IP
arp[4] = 6; arp[5] = 4; // Lens
arp.writeUInt16BE(1, 6); // Op Request
Buffer.from([0x02,0x00,0x00,0x00,0x00,0x01]).copy(arp, 8); // Sender MAC
Buffer.from([192,168,127,3]).copy(arp, 14); // Sender IP
Buffer.from([0,0,0,0,0,0]).copy(arp, 18); // Target MAC
Buffer.from([192,168,127,1]).copy(arp, 24); // Target IP (Gateway)

const frame = Buffer.concat([eth, arp]);
net.receive(frame);

assert.strictEqual(messages.length, 1);
const reply = messages[0];
const replyOp = reply.readUInt16BE(14 + 6);
assert.strictEqual(replyOp, 2); // Reply
console.log("ARP Reply received correctly.");

console.log("Testing ICMP Echo...");
messages.length = 0;
// IP Header (20)
const ip = Buffer.alloc(20);
ip[0] = 0x45;
ip.writeUInt16BE(20+8, 2); // Len
ip[9] = 1; // ICMP
Buffer.from([192,168,127,3]).copy(ip, 12);
Buffer.from([192,168,127,1]).copy(ip, 16);
ip.writeUInt16BE(net.calculateChecksum(ip), 10);

// ICMP Echo Request
const icmp = Buffer.alloc(8);
icmp[0] = 8; // Type Echo Request
icmp.writeUInt16BE(0, 2); // Checksum (invalid for test?)

const ipFrame = Buffer.concat([eth, ip, icmp]);
// Fix Eth type to IP
ipFrame.writeUInt16BE(0x0800, 12); 

net.receive(ipFrame);
assert.strictEqual(messages.length, 1);
const ipReply = messages[0];
const icmpType = ipReply[14 + 20]; // Eth(14) + IP(20) + ICMP Type(0)
assert.strictEqual(icmpType, 0); // Echo Reply
console.log("ICMP Reply received correctly.");

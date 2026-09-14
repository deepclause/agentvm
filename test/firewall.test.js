'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFirewall, matchFirewall, hostnameMatches, parsePortSpec } = require('../src/firewall');

test('normalizeFirewall validates and normalizes rules', () => {
    const fw = normalizeFirewall({
        default: 'deny',
        rules: [
            { id: 'allow-dns', direction: 'out', protocol: 'udp', remote: '*', port: 53, action: 'allow' },
            { id: 'block-tls', direction: 'out', protocol: 'tcp', remote: '*.example.com', port: '443', action: 'deny' },
        ],
    });
    assert.equal(fw.default, 'deny');
    assert.equal(fw.rules.length, 2);
    assert.equal(fw.rules[0].port.type, 'single');
    assert.equal(fw.rules[0].port.port, 53);
});

test('normalizeFirewall rejects invalid input', () => {
    assert.throws(() => normalizeFirewall({ default: 'maybe' }), /default/);
    assert.throws(() => normalizeFirewall({ rules: [{ direction: 'sideways' }] }), /direction/);
    assert.throws(() => normalizeFirewall({ rules: [{ direction: 'out', protocol: 'tcp', remote: 'not a host!', port: 80, action: 'deny' }] }), /remote/);
    assert.throws(() => normalizeFirewall({ rules: [{ direction: 'out', protocol: 'tcp', remote: '10.0.0.0/33', port: 80, action: 'deny' }] }), /CIDR/);
    assert.throws(() => normalizeFirewall({ rules: [{ direction: 'out', protocol: 'tcp', remote: '*', port: '70000', action: 'deny' }] }), /port/);
});

test('firewall matching honors order, protocol, ports, IP, CIDR and wildcard remote', () => {
    const fw = normalizeFirewall({
        default: 'allow',
        rules: [
            { id: 'allow-one', direction: 'out', protocol: 'tcp', remote: '10.1.2.3', port: '8000-9000', action: 'allow' },
            { id: 'block-subnet', direction: 'out', protocol: 'tcp', remote: '10.0.0.0/8', port: '*', action: 'deny' },
            { id: 'block-dns', direction: 'out', protocol: 'udp', remote: '*', port: 53, action: 'deny' },
        ],
    });

    assert.equal(matchFirewall(fw, { direction: 'out', protocol: 'tcp', remoteIP: '10.2.3.4', port: 443 }), 'deny');
    assert.equal(matchFirewall(fw, { direction: 'out', protocol: 'tcp', remoteIP: '10.1.2.3', port: 8443 }), 'allow');
    assert.equal(matchFirewall(fw, { direction: 'out', protocol: 'udp', remoteIP: '1.2.3.4', port: 53 }), 'deny');
    assert.equal(matchFirewall(fw, { direction: 'out', protocol: 'tcp', remoteIP: '1.2.3.4', port: 443 }), 'allow');
});

test('hostname wildcard matching matches a single DNS label', () => {
    assert.equal(hostnameMatches('*.example.com', 'api.example.com'), true);
    assert.equal(hostnameMatches('*.example.com', 'a.b.example.com'), false);
    assert.equal(hostnameMatches('*.example.com', 'example.com'), false);
    assert.equal(hostnameMatches('api.example.com', 'api.example.com'), true);
    assert.equal(hostnameMatches('api.example.com', 'API.EXAMPLE.COM'), true);
});

test('port specs parse single values and ranges', () => {
    assert.equal(parsePortSpec('*').type, 'any');
    assert.deepEqual(parsePortSpec('443'), { type: 'single', port: 443 });
    assert.deepEqual(parsePortSpec('8000-9000'), { type: 'range', start: 8000, end: 9000 });
    assert.equal(parsePortSpec('0-1'), null);
});

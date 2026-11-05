'use strict';

/**
 * Firewall rule validation and matching for AgentVM.
 *
 * Rule shape (as described in docs/network-persistence-proposal.md):
 *   {
 *     id: 'block-example-tls',
 *     direction: 'out',        // 'out' = guest-initiated, 'in' = port-forwarded
 *     protocol: 'tcp',         // 'tcp' | 'udp'
 *     remote: '*.example.com', // hostname | IP | CIDR | '*'
 *     port: '443',             // port | '8000-9000' | '*'
 *     action: 'deny'           // 'allow' | 'deny'
 *   }
 *
 * Rules are ordered and first match wins. The default action is configurable.
 * Matching is synchronous for IP/CIDR/port/hostname-name rules; callers may
 * additionally resolve hostname rules to IPs themselves for IP-based matching.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

function isIpv4(value) {
    const match = IPV4_RE.exec(String(value));
    if (!match) return false;
    return match.slice(1).every((part) => Number(part) <= 255);
}

function ipv4ToInt(value) {
    const parts = String(value).split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(value) {
    const parts = String(value).split('/');
    if (parts.length !== 2 || !isIpv4(parts[0])) return null;
    const prefix = Number(parts[1]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const ip = ipv4ToInt(parts[0]);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { start: (ip & mask) >>> 0, end: ((ip & mask) | ~mask) >>> 0 };
}

function ipMatchesCidr(ip, cidr) {
    const range = parseCidr(cidr);
    if (!range || !isIpv4(ip)) return false;
    const value = ipv4ToInt(ip);
    return value >= range.start && value <= range.end;
}

function isHostname(value) {
    const str = String(value);
    if (str === '*' || isIpv4(str) || str.includes('/')) return false;
    // A hostname pattern is dot-separated labels where '*' may replace a label.
    return str.split('.').every((label) => {
        if (label === '*') return true;
        return HOSTNAME_LABEL_RE.test(label);
    });
}

function hostnameMatches(pattern, hostname) {
    if (!isHostname(pattern)) return false;
    const patternLabels = String(pattern).toLowerCase().split('.');
    const nameLabels = String(hostname).toLowerCase().split('.').filter(Boolean);
    if (patternLabels.length !== nameLabels.length) return false;
    for (let i = 0; i < patternLabels.length; i++) {
        if (patternLabels[i] === '*') continue;
        if (patternLabels[i] !== nameLabels[i]) return false;
    }
    return true;
}

function parsePortSpec(value) {
    if (value === undefined || value === null) return null;
    if (value === '*' || value === '') return { type: 'any' };
    const str = String(value).trim();
    if (str === '*') return { type: 'any' };
    if (/^\d+$/.test(str)) {
        const port = Number(str);
        if (port < 1 || port > 65535) return null;
        return { type: 'single', port };
    }
    const range = /^(\d+)-(\d+)$/.exec(str);
    if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start < 1 || end > 65535 || start > end) return null;
        return { type: 'range', start, end };
    }
    return null;
}

function portMatches(spec, port) {
    if (spec === undefined || spec === null) return false;
    const parsed = typeof spec === 'object' ? spec : parsePortSpec(spec);
    if (!parsed) return false;
    if (parsed.type === 'any') return true;
    const value = Number(port);
    if (!Number.isInteger(value)) return false;
    if (parsed.type === 'single') return value === parsed.port;
    return value >= parsed.start && value <= parsed.end;
}

function remoteMatches(remote, remoteIP, hostname) {
    if (remote === '*' ) return true;
    if (isIpv4(remote)) return remoteIP === remote;
    if (remote.includes('/')) return ipMatchesCidr(remoteIP, remote);
    if (hostname && isHostname(remote)) return hostnameMatches(remote, hostname);
    return false;
}

/**
 * Normalize and validate a firewall configuration. Throws on invalid input.
 * @param {Object} config - { default, rules }
 * @returns {Object} - { default: 'allow'|'deny', rules: FirewallRule[] }
 */
function normalizeFirewall(config = {}) {
    const defaultAction = config.default === undefined ? 'allow' : config.default;
    if (defaultAction !== 'allow' && defaultAction !== 'deny') {
        throw new Error(`Invalid firewall default action: ${defaultAction}`);
    }

    const rulesInput = Array.isArray(config.rules) ? config.rules : [];
    const rules = rulesInput.map((rule, index) => {
        if (!rule || typeof rule !== 'object') {
            throw new Error(`Firewall rule ${index} must be an object`);
        }
        const direction = rule.direction;
        if (direction !== 'in' && direction !== 'out') {
            throw new Error(`Firewall rule ${index} has invalid direction: ${direction}`);
        }
        const protocol = rule.protocol;
        if (protocol !== 'tcp' && protocol !== 'udp') {
            throw new Error(`Firewall rule ${index} has invalid protocol: ${protocol}`);
        }
        const action = rule.action;
        if (action !== 'allow' && action !== 'deny') {
            throw new Error(`Firewall rule ${index} has invalid action: ${action}`);
        }
        const remote = String(rule.remote == null ? '*' : rule.remote);
        if (remote !== '*' && !isIpv4(remote) && !remote.includes('/') && !isHostname(remote)) {
            throw new Error(`Firewall rule ${index} has invalid remote: ${remote}`);
        }
        if (remote.includes('/') && !parseCidr(remote)) {
            throw new Error(`Firewall rule ${index} has invalid CIDR: ${remote}`);
        }
        if (!parsePortSpec(rule.port)) {
            throw new Error(`Firewall rule ${index} has invalid port: ${rule.port}`);
        }
        return {
            id: rule.id !== undefined ? String(rule.id) : `rule-${index}`,
            direction,
            protocol,
            remote,
            port: parsePortSpec(rule.port),
            action,
        };
    });

    return { default: defaultAction, rules };
}

/**
 * Match a connection/datagram against a normalized firewall. First match wins.
 * @param {Object} firewall - normalized firewall { default, rules }
 * @param {Object} ctx - { direction, protocol, remoteIP, port, hostname }
 * @returns {'allow'|'deny'}
 */
function matchFirewall(firewall, ctx) {
    const { direction, protocol, remoteIP, port, hostname } = ctx;
    for (const rule of firewall.rules) {
        if (rule.direction !== direction) continue;
        if (rule.protocol !== protocol) continue;
        if (!portMatches(rule.port, port)) continue;
        if (remoteMatches(rule.remote, remoteIP || null, hostname || null)) {
            return rule.action;
        }
    }
    return firewall.default;
}

/**
 * Return hostname rules for a direction/protocol that need DNS resolution to
 * match an IP address (i.e. remote is a non-wildcard hostname).
 */
function hostnameRulesForIp(firewall, direction, protocol) {
    const result = [];
    for (const rule of firewall.rules) {
        if (rule.direction !== direction) continue;
        if (rule.protocol !== protocol) continue;
        if (isHostname(rule.remote) && !rule.remote.includes('*')) {
            result.push(rule);
        }
    }
    return result;
}

module.exports = {
    normalizeFirewall,
    matchFirewall,
    remoteMatches,
    hostnameRulesForIp,
    isIpv4,
    isHostname,
    hostnameMatches,
    portMatches,
    parseCidr,
    parsePortSpec,
};

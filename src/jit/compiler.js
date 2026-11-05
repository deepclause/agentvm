'use strict';

const crypto = require('node:crypto');
const { buildRegion } = require('./region');
const { buildModule, buildModuleMany } = require('./emitter');

// Bump whenever the region ABI or emitted code changes. It is part of the
// persistent-cache key, so stale translations are never reused.
const TRANSLATOR_VERSION = 4;
const REGION_ABI = 1;

function keyFor(pageBytes, entryOff, priv, fs) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from([TRANSLATOR_VERSION, REGION_ABI, entryOff & 0xff, (entryOff >> 8) & 0xf]));
    hash.update(Buffer.from([priv & 3, fs ? 1 : 0]));
    hash.update(pageBytes);
    return hash.digest('hex');
}

// Compile a single entry. Returns the module bytes, the region CFG and the
// export name. This is the synchronous MVP path used by the emulator worker.
function compileRegion(pageBytes, entryOff, options = {}) {
    const region = buildRegion(pageBytes, entryOff, options);
    const moduleBytes = buildModule(region, options);
    return {
        moduleBytes,
        region,
        exportName: 'region',
        key: options.key || keyFor(pageBytes, entryOff, options.priv || 0, options.fs || 0),
        insnCount: region.totalInsns,
    };
}

// Compile several entries of the same page into one module. This is the unit
// the compiler worker uses for batching (many regions per WebAssembly.Module).
function compileBatch(pageBytes, entries, options = {}) {
    const regions = entries.map((entry) => buildRegion(pageBytes,
        typeof entry === 'number' ? entry : entry.off, options));
    const moduleBytes = regions.length === 1
        ? buildModule(regions[0], options)
        : buildModuleMany(regions, options);
    return {
        moduleBytes,
        regions,
        exportNames: regions.map((_, i) => (regions.length === 1 ? 'region' : `region_${i}`)),
        keys: entries.map((entry) => {
            const off = typeof entry === 'number' ? entry : entry.off;
            return keyFor(pageBytes, off, options.priv || 0, options.fs || 0);
        }),
        insnCount: regions.reduce((n, r) => n + r.totalInsns, 0),
    };
}

module.exports = { TRANSLATOR_VERSION, REGION_ABI, keyFor, compileRegion, compileBatch };

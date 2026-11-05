'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// On-disk cache for translated regions. Node has no API for caching compiled
// wasm code, so the cache stores the module bytes and a small index. The key is
// a content hash (see compiler.keyFor), so a translation is reusable across
// processes and VM runs.
class TranslationCache {
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.root = options.root || path.join(os.homedir(), '.cache', 'agentvm');
        this.buildId = options.buildId || 'unknown';
        this.dir = path.join(this.root, this.buildId, 'jit');
        this.indexFile = path.join(this.dir, 'index.json');
        this.index = new Map();
        this.dirty = false;
        if (this.enabled) this._loadIndex();
    }

    _loadIndex() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
            for (const [key, value] of Object.entries(raw.entries || {})) {
                this.index.set(key, value);
            }
        } catch {
            // Missing or corrupt index: start empty.
        }
    }

    _saveIndex() {
        if (!this.enabled || !this.dirty) return;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const entries = Object.fromEntries(this.index);
            fs.writeFileSync(this.indexFile, JSON.stringify({ version: 1, entries }));
            this.dirty = false;
        } catch {
            // Caching is an optimization; never fail the VM because of it.
        }
    }

    get(key) {
        if (!this.enabled) return null;
        const entry = this.index.get(key);
        if (!entry) return null;
        try {
            const bytes = fs.readFileSync(path.join(this.dir, entry.file));
            return { bytes, meta: entry };
        } catch {
            this.index.delete(key);
            this.dirty = true;
            return null;
        }
    }

    put(key, bytes, meta = {}) {
        if (!this.enabled) return false;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const file = `${key.slice(0, 32)}.wasm`;
            fs.writeFileSync(path.join(this.dir, file), bytes);
            this.index.set(key, { file, size: bytes.length, ...meta });
            this.dirty = true;
            return true;
        } catch {
            return false;
        }
    }

    flush() {
        this._saveIndex();
    }
}

module.exports = { TranslationCache };

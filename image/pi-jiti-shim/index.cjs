'use strict';
// Fast jiti shim for AgentVM.
//
// pi loads TypeScript extensions through jiti, whose bundled Babel transform is
// extremely slow under emulation: ~4 s just to load the Babel bundle, plus
// ~2 s per KB of source (an 8.5 KB extension took ~21 s cold). esbuild is a
// native riscv64 binary that transforms the same file in milliseconds, and it
// is already installed (a dependency of @earendil-works/chord).
//
// This module is installed as the `jiti` package (the real one is renamed
// `jiti-real`); it wraps createJiti and injects an esbuild transform. esbuild
// cannot emit top-level await as CommonJS, so files it rejects fall back to the
// real Babel transform (loaded lazily, once). If esbuild is unavailable, or the
// caller already supplied a transform, the real jiti/Babel path is used
// unchanged.
//
// esbuild's CommonJS output also blanks `import.meta` (`const import_meta = {}`),
// which breaks extensions that resolve their own path at load time (pi-subagents
// calls `fileURLToPath(import.meta.url)`); Babel inlines the value, so we
// substitute it before transforming.
//
// jiti's filesystem cache (`$TMPDIR/jiti`) is keyed by source, not by transform,
// so cached output from an older transform can outlive a shim change. Bump
// SHIM_CACHE_TAG to force a rebuild of stale entries.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const real = require('jiti-real');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  // keep Babel fallback
}

let babelTransform;
function getBabelTransform() {
  if (babelTransform === undefined) {
    try {
      babelTransform = require(path.join(__dirname, '..', 'jiti-real', 'dist', 'babel.cjs'));
    } catch {
      babelTransform = null;
    }
  }
  return babelTransform;
}

/** esbuild blanks import.meta for CJS; inline the values Babel would produce. */
function rewriteImportMeta(source, filename) {
  if (typeof filename !== 'string' || !/import\s*\.\s*meta\b/.test(source)) return source;
  const url = pathToFileURL(filename).href;
  return source
    .replace(/\bimport\s*\.\s*meta\s*\.\s*url\b/g, JSON.stringify(url))
    .replace(/\bimport\s*\.\s*meta\s*\.\s*filename\b/g, JSON.stringify(filename))
    .replace(/\bimport\s*\.\s*meta\s*\.\s*dirname\b/g, JSON.stringify(path.dirname(filename)));
}

const fastTransform = (opts) => {
  if (!esbuild) return getBabelTransform()(opts);
  try {
    return {
      code: esbuild.transformSync(rewriteImportMeta(opts.source, opts && opts.filename), {
        loader: opts && opts.ts === false ? 'js' : 'ts',
        format: 'cjs',
        target: 'node20'
      }).code
    };
  } catch (error) {
    const babel = getBabelTransform();
    if (babel) return babel(opts);
    throw error;
  }
};

function createJiti(base, options = {}) {
  if (!esbuild || options.transform) return real.createJiti(base, options);
  return real.createJiti(base, { ...options, transform: fastTransform });
}

module.exports = { ...real, createJiti };

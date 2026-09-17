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
const path = require('node:path');
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

const fastTransform = (opts) => {
  if (!esbuild) return getBabelTransform()(opts);
  try {
    return {
      code: esbuild.transformSync(opts.source, {
        loader: opts && opts.ts === false ? 'js' : 'ts',
        format: 'cjs',
        target: 'node20',
      }).code,
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

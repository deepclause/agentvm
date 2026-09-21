import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Import the real jiti engine directly rather than ../jiti-real/lib/jiti-static.mjs:
// that module eagerly imports dist/babel.cjs (~4s under emulation), which we only
// need for files esbuild cannot handle.
import _createJiti from '../jiti-real/dist/jiti.cjs';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const nativeImport = (id) => import(id);
function onError(err) {
  throw err;
}

// Babel is only loaded if esbuild rejects a file (e.g. top-level await, which
// esbuild refuses to emit as CommonJS). Lazy so the common path never pays for it.
let babelTransform;
function getBabelTransform() {
  if (babelTransform === undefined) {
    try {
      babelTransform = require('../jiti-real/dist/babel.cjs');
    } catch {
      babelTransform = null;
    }
  }
  return babelTransform;
}

// esbuild blanks import.meta for CJS; inline the values Babel would produce.
function rewriteImportMeta(source, filename) {
  if (typeof filename !== 'string' || !/import\s*\.\s*meta\b/.test(source)) return source;
  const url = pathToFileURL(filename).href;
  return source
    .replace(/\bimport\s*\.\s*meta\s*\.\s*url\b/g, JSON.stringify(url))
    .replace(/\bimport\s*\.\s*meta\s*\.\s*filename\b/g, JSON.stringify(filename))
    .replace(/\bimport\s*\.\s*meta\s*\.\s*dirname\b/g, JSON.stringify(path.dirname(filename)));
}

const fastTransform = (opts) => {
  try {
    return {
      code: esbuild.transformSync(
        rewriteImportMeta(opts.source, opts && opts.filename),
        {
          loader: opts && opts.ts === false ? 'js' : 'ts',
          format: 'cjs',
          target: 'node20',
        }
      ).code,
    };
  } catch (error) {
    const babel = getBabelTransform();
    if (babel) return babel(opts);
    throw error;
  }
};

export function createJiti(id, opts = {}) {
  if (!opts.transform) {
    opts = { ...opts, transform: fastTransform };
  }
  return _createJiti(id, opts, { onError, nativeImport, createRequire });
}

export default createJiti;

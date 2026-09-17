import { createRequire } from 'node:module';
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

const fastTransform = (opts) => {
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

export function createJiti(id, opts = {}) {
  if (!opts.transform) {
    opts = { ...opts, transform: fastTransform };
  }
  return _createJiti(id, opts, { onError, nativeImport, createRequire });
}

export default createJiti;

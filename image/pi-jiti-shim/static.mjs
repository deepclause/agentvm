import { createJiti as realCreateJiti } from '../jiti-real/lib/jiti-static.mjs';
import * as esbuild from 'esbuild';

const fastTransform = (opts) => ({
  code: esbuild.transformSync(opts.source, {
    loader: opts && opts.ts === false ? 'js' : 'ts',
    format: 'cjs',
    target: 'node20',
  }).code,
});

export function createJiti(base, options = {}) {
  if (options.transform) return realCreateJiti(base, options);
  return realCreateJiti(base, { ...options, transform: fastTransform });
}
export default createJiti;

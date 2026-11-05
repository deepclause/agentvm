import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const shim = require('./index.cjs');
export const createJiti = shim.createJiti;
export default shim;

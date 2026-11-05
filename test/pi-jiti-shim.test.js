// pi extension loading uses the jiti shim (esbuild transform), not Babel.
//
// pi compiles TypeScript extensions with jiti, whose bundled Babel transform
// costs ~4s to load plus ~2s/KB under emulation (~28s for a 5KB extension).
// Dockerfile.pi installs image/pi-jiti-shim as the `jiti` package (the real
// one becomes `jiti-real`), which injects an esbuild transform. This test
// guards the packaging: the resolved `jiti` must be the shim, a TS extension
// must load through it, and an extension using top-level await (which esbuild
// cannot emit as CJS) must still load via the lazy Babel fallback.
const { AgentVM } = require('../src/index');

function withTimeout(promise, ms = 60000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}

const PI = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent';

// A typed extension large enough that the Babel path would be clearly slow.
const EXT_TS = `interface Opts { name: string }\ntype Tool = { name: string; run(o: Opts): Promise<string> }\nexport function mk(name: string): Tool { return { name, async run(o: Opts) { return 'hi ' + o.name } } }\n` +
    Array.from({ length: 80 }, (_, i) => `export const h${i} = (x: number): Promise<number> => Promise.resolve((x + ${i}) as number);`).join('\n') + '\n';

// Top-level await: esbuild rejects this for the `cjs` output format, so it
// must fall back to the real Babel transform.
const EXT_TLA_TS = `import type { Meta } from './tla-meta.ts';\nconst impl = process.env.PI_SUBAGENT_CHILD === '1'\n  ? (await import('./tla-impl.ts')).default\n  : { name: 'inline' };\nexport default function register(pi: unknown): void { void impl; const m: Meta = { v: 1 }; void m; void pi; }\n`;
const EXT_TLA_META = `export interface Meta { v: number }\n`;
const EXT_TLA_IMPL = `export default { name: 'impl' }\n`;

// Resolving paths via import.meta.url at load time (pi-subagents does this).
const EXT_META_TS = `export const metaUrl = import.meta.url;\n`;

const BENCH = `const { createRequire } = require('node:module');
const req = createRequire('${PI}/package.json');
async function main() {
  const resolved = req.resolve('jiti');
  const { createJiti } = req('jiti');
  const t0 = Date.now();
  const jiti = createJiti(__filename, { moduleCache: false });
  const m = await jiti.import('/tmp/ext/ext.ts', { default: true });
  console.log('RESULT ok=' + (typeof m === 'object') + ' ms=' + (Date.now() - t0) + ' jiti=' + resolved);

  // Top-level await through the jiti/static entry (the one pi's loader uses).
  const t1 = Date.now();
  const staticJiti = (await import('${PI}/node_modules/jiti/static.mjs')).createJiti;
  const jiti2 = staticJiti(__filename, { moduleCache: false });
  const m2 = await jiti2.import('/tmp/ext/tla.ts', { default: true });
  console.log('TLA ok=' + (typeof m2 === 'function') + ' ms=' + (Date.now() - t1));

  const m3 = await jiti.import('/tmp/ext/meta.ts');
  console.log('META url=' + m3.metaUrl);
}
main().catch((e) => console.log('RESULT err=' + e.message));
`;

async function test() {
    const vm = new AgentVM();
    let failures = 0;
    const check = (name, ok, detail) => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
        if (!ok) failures++;
    };
    try {
        await withTimeout(vm.start(), 60000);

        // Write the extensions and bench harness into the guest.
        await withTimeout(vm.exec(`mkdir -p /tmp/ext && cat > /tmp/ext/ext.ts <<'EOF'\n${EXT_TS}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/tla-meta.ts <<'EOF'\n${EXT_TLA_META}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/tla-impl.ts <<'EOF'\n${EXT_TLA_IMPL}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/tla.ts <<'EOF'\n${EXT_TLA_TS}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/meta.ts <<'EOF'\n${EXT_META_TS}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/bench.cjs <<'EOF'\n${BENCH}EOF`), 20000);

        const res = await withTimeout(vm.exec('node /tmp/ext/bench.cjs 2>&1'), 180000);
        const out = res.stdout.trim();

        check('jiti resolves to the AgentVM shim', /jiti[\\/](index\.cjs|package\.json)/.test(out), out.split('\n')[0]);
        check('jiti-real (babel) is kept', /jiti\-real/.test((await withTimeout(vm.exec('ls /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/ 2>&1'), 20000)).stdout));
        check('typescript extension loads through the shim', /RESULT ok=true/.test(out), out.split('\n')[0]);
        check('top-level await extension loads (Babel fallback)', /TLA ok=true/.test(out), (out.split('\n').find((l) => l.startsWith('TLA ')) || ''));
        check(
            'import.meta.url resolves to the file URL',
            /META url=file:\/\/\/tmp\/ext\/meta\.ts/.test(out),
            (out.split('\n').find((l) => l.startsWith('META ')) || '')
        );

        const ms = Number((out.match(/ms=(\d+)/) || [])[1] || 0);
        check('cold load is well under the Babel path (>28s)', ms > 0 && ms < 15000, `ms=${ms}`);
    } catch (e) {
        console.error('TEST ERROR:', e);
        failures++;
    } finally {
        await vm.stop();
        console.log(failures === 0 ? '\nAll pi jiti-shim tests passed.' : `\n${failures} pi jiti-shim test(s) failed.`);
        if (failures) process.exit(1);
    }
}

test();

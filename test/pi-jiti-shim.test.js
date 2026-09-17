// pi extension loading uses the jiti shim (esbuild transform), not Babel.
//
// pi compiles TypeScript extensions with jiti, whose bundled Babel transform
// costs ~4s to load plus ~2s/KB under emulation (~28s for a 5KB extension).
// Dockerfile.pi installs image/pi-jiti-shim as the `jiti` package (the real
// one becomes `jiti-real`), which injects an esbuild transform. This test
// guards the packaging: the resolved `jiti` must be the shim, and a TS
// extension must load through it.
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

const BENCH = `const { createRequire } = require('node:module');
const req = createRequire('${PI}/package.json');
const resolved = req.resolve('jiti');
const { createJiti } = req('jiti');
const t0 = Date.now();
const jiti = createJiti(__filename, { moduleCache: false });
jiti.import('/tmp/ext/ext.ts', { default: true }).then(
  (m) => console.log('RESULT ok=' + (typeof m === 'object') + ' ms=' + (Date.now() - t0) + ' jiti=' + resolved),
  (e) => console.log('RESULT err=' + e.message));
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

        // Write the extension and bench harness into the guest.
        await withTimeout(vm.exec(`mkdir -p /tmp/ext && cat > /tmp/ext/ext.ts <<'EOF'\n${EXT_TS}EOF`), 20000);
        await withTimeout(vm.exec(`cat > /tmp/ext/bench.cjs <<'EOF'\n${BENCH}EOF`), 20000);

        const res = await withTimeout(vm.exec('node /tmp/ext/bench.cjs 2>&1'), 120000);
        const out = res.stdout.trim();

        check('jiti resolves to the AgentVM shim', /jiti[\\/](index\.cjs|package\.json)/.test(out), out);
        check('jiti-real (babel) is kept', /jiti\-real/.test((await withTimeout(vm.exec('ls /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/ 2>&1'), 20000)).stdout));
        check('typescript extension loads through the shim', /RESULT ok=true/.test(out), out);

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

# pi extension loading (jiti) under emulation

pi loads TypeScript extensions through [jiti](https://github.com/unjs/jiti).
jiti 2.7 bundles its own Babel (`node_modules/jiti/dist/babel.cjs`, 1.5 MB) and
transpiles TS/ESM at runtime. Under the riscv64 emulator that is the single
slowest thing about starting pi with extensions.

## Measurements

All in the guest, `todo`-derived TS extension, cold jiti filesystem cache
(`/tmp/jiti` cleared) unless noted. Node startup alone is ~1.6 s.

| path | cold | warm (fsCache) |
|---|---:|---:|
| stock jiti (Babel), ~5.5 KB TS | **27.9 s** | 0.38 s |
| stock jiti, 8.5 KB TS | ~21 s | 0.29 s |
| stock jiti, 50 B TS | ~4.0 s | — |
| jiti + esbuild transform (shim) | **5.0 s** | 0.37 s |
| native `import()` of precompiled ESM | **0.06 s** | — |
| in-guest esbuild transform (alone) | ~1.5 s | — |
| host esbuild (x64) | ~instant | — |

Breakdown of the stock cold cost: ~4 s is loading/compiling the Babel bundle,
and the rest scales with source size (~2 s/KB). `createJiti` itself is ~0.1 s.
The fsCache turns any repeat load into ~0.3 s, but it is **keyed by path** (the
same bytes under a different filename miss) and lives in `$TMPDIR/jiti`, which
is tmpfs in the guest — so it is cold again after every VM restart.

Things that do **not** help: `JITI_TRY_NATIVE`, `tryNative`, `nativeModules`
(jiti still transforms), and Node's `--experimental-strip-types` (the Alpine
Node is not compiled with TypeScript support).

## Solutions

### A. jiti shim with an esbuild transform (shipped, `image/pi-jiti-shim`)

jiti accepts a custom `transform` option. esbuild is already installed (a
dependency of `@earendil-works/chord`) and has a native **riscv64** binary, so
`createJiti` can be wrapped to inject an esbuild transform instead of Babel.
This is a monkey-patch of the `jiti` package, not of pi:

- `image/pi-jiti-shim` is copied into the image and installed as
  `.../pi-coding-agent/node_modules/jiti`; the real jiti is renamed
  `jiti-real`. `Dockerfile.pi` does the swap.
- `createJiti` forwards every option (including pi's `alias`/`virtualModules`)
  and only adds `transform`. If esbuild is missing, or a caller already passed
  a transform, it defers to real jiti/Babel.

Result: cold **27.9 s → 5.0 s**, warm unchanged.

Caveat: esbuild cannot emit top-level `await` as CommonJS (it errors with
`Top-level await is currently not supported with the "cjs" output format`).
Extensions that use it (e.g. `pi-subagents`) therefore fall back to the real
Babel transform, which is imported lazily on first failure — so the common path
still never loads Babel. A TLA extension loads in ~14 s cold (Babel load +
transform) and ~0.14 s once warm; without the fallback it fails outright and pi
exits, which surfaced as pi-box reconnecting in a loop.

esbuild's CommonJS output also blanks `import.meta` (`const import_meta = {}`), so
`import.meta.url` becomes `undefined`. Extensions that resolve their own files at
load time (pi-subagents does `fileURLToPath(import.meta.url)` in
`src/agents/agents.ts`) then throw `ERR_INVALID_ARG_TYPE`. Babel inlines the
value, so the shim substitutes the file URL/dirname/filename before transforming.

`static.mjs` imports `jiti-real/dist/jiti.cjs` directly instead of
`jiti-real/lib/jiti-static.mjs`, because the latter eagerly imports
`dist/babel.cjs` (~4 s) even when no file needs it.

**Cache invalidation.** jiti caches transpiled output in `$TMPDIR/jiti` keyed by
source (not by transform). Changing the shim does **not** invalidate existing
entries, so stale output (e.g. the old `import.meta`-blanking transform) keeps
being served and the transform is never called again. Clear `$TMPDIR/jiti`
after changing the transform (`rm -rf /tmp/jiti`), and ship a clean cache in the
image.

### B. Warm / persist the fsCache

No patch needed. jiti's cache dir follows `os.tmpdir()`, and jiti honours
`TMPDIR` when `JITI_RESPECT_TMPDIR_ENV=1` (verified: the cache lands in
`$TMPDIR/jiti`). Point `TMPDIR` at a persistent location (persistent root, or a
host mount) and pre-populate it to make repeat loads ~0.3 s even across VM
restarts. Caveat: path-keyed, so it must be warmed at the exact extension
paths.

### C. Precompile and bypass jiti

Precompiled ESM loads in ~0.06 s, a further ~80× over the warm cache. This
needs a pi patch: the bundled loader
(`dist/bundle/chunks/chunk-JVUZSMYM.js`, `loadExtensionModule`) would have to
check for a `.js` sibling and `import()` it instead of calling jiti. Risks:
pi's `alias`/`virtualModules` resolution is lost for native imports (bare
`.pi/extensions/*.ts` files that import `@earendil-works/pi-*` rely on it), and
the chunk name is content-hashed.

### D. Host interaction

The host (x64) transpiles instantly with esbuild. Two options if in-guest
esbuild is ever a problem: pre-transpile extensions into the workspace on the
host before pi runs, or pre-warm the jiti cache from the host. The shim (A)
makes this unnecessary for now, since riscv64 esbuild is available in-guest.

## Status

Shipped (A): `image/pi-jiti-shim` + `Dockerfile.pi` swap + rebuilt default
image. Guarded by `test/pi-jiti-shim.test.js` (resolves to the shim, loads a TS
extension, loads a top-level-await extension through `jiti/static`, asserts the
cold load is far below the Babel path). Commit on `perf/pi-jiti-fast`.

Follow-ups if more is needed: warm the fsCache in the image (B), or the pi
loader patch (C).

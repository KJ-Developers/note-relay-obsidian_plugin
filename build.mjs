import { build } from 'esbuild';

/**
 * The Worker origin is compiled in, not read at runtime.
 *
 * `NR_WORKER_ORIGIN` overrides it; unset, the build compiles the **production** origin. That default
 * is deliberate and is the safer direction: a clean checkout, and the community directory's own build
 * verifier, must be able to run `pnpm run build` with no environment at all — and if someone does
 * forget to set a variable, an accidentally-published bundle then points at production rather than at
 * a development Worker. A development build sets the variable explicitly.
 * `scripts/check-release-build.mjs` still refuses a bundle that names a development endpoint.
 */
const PRODUCTION_ORIGIN = 'https://api.noterelay.io';
const origin = (process.env.NR_WORKER_ORIGIN ?? '').trim().replace(/\/+$/, '') || PRODUCTION_ORIGIN;
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?$/i.test(origin)) {
  throw new Error(`NR_WORKER_ORIGIN must be an https origin, got: ${origin}`);
}
if (origin !== PRODUCTION_ORIGIN) {
  console.log(`Note Relay: building against ${origin} (NR_WORKER_ORIGIN override)`);
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  // `node:os` is reached for the machine label; it is a runtime Electron/Node module, never bundled.
  external: ['obsidian', 'electron', 'node:os'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  define: { __NR_WORKER_ORIGIN__: JSON.stringify(origin) },
});

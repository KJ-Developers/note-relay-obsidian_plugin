import { build } from 'esbuild';

/**
 * The Worker origin is compiled in, not read at runtime.
 *
 * Every build must name its endpoint with `NR_WORKER_ORIGIN`. There is deliberately no default: a
 * default would put a development hostname inside a bundle someone publishes, and a published default
 * would leave every installed copy pointing at a Worker that may later be retired. Development and
 * release bundles differ only in this value, and `scripts/check-release-build.mjs` refuses a release
 * build that still names a development endpoint.
 */
const origin = (process.env.NR_WORKER_ORIGIN ?? '').trim().replace(/\/+$/, '');
if (!origin) {
  throw new Error(
    'Set NR_WORKER_ORIGIN to the Worker origin this build should talk to, for example\n'
    + '  NR_WORKER_ORIGIN=https://api.noterelay.io pnpm build',
  );
}
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?$/i.test(origin)) {
  throw new Error(`NR_WORKER_ORIGIN must be an https origin, got: ${origin}`);
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  define: { __NR_WORKER_ORIGIN__: JSON.stringify(origin) },
});

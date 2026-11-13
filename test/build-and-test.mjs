import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// One list, used twice. This file used to name every test twice — once to bundle it and once to run
// it — and adding a file to only the first list built a test that was never executed, so a new test
// file silently contributed zero tests while the suite still reported green. Derive the run list from
// this array and the two cannot drift apart again.
const entries = [
  'protocol', 'update-check', 'preview', 'host-boundary', 'framing', 'host-lifecycle', 'framed-channel',
  'peer-grant', 'authenticated-read-session', 'pairing-key', 'pairing-key-store', 'pairing-flow',
  'host-presence-proof', 'search', 'transclusion', 'mermaid', 'reconnect', 'host-waiting',
  'host-socket', 'diagnostics', 'device-grant-client', 'account-binding', 'device-api',
  'release-build-check',
];

await mkdir('.test-build', { recursive: true });
await build({
  entryPoints: entries.map(name => `test/${name}.test.ts`),
  outdir: '.test-build',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['jsdom'],
  // The `obsidian` package is types only, so any module that imports `Notice` cannot be bundled for
  // node. The alias gives those modules a runnable stand-in, which is what lets the signal client
  // have a real fake-transport test rather than only a state-machine test.
  alias: { obsidian: './test/obsidian-stub.ts' },
  logLevel: 'silent',
  // The endpoint is a build-time constant; tests use a clearly fake release origin so a test can
  // never reach a real Worker.
  define: { __NR_WORKER_ORIGIN__: JSON.stringify('https://worker.test') },
});
const result = spawnSync(process.execPath,
  ['--test', ...entries.map(name => `.test-build/${name}.test.js`)], { stdio: 'inherit' });
process.exit(result.status ?? 1);

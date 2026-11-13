import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The release check is the last thing standing between a development bundle and a published plugin, so
// it has to be exercised as the release job runs it. It previously counted the public site as a second
// application origin and refused a correct production bundle, which would have blocked every release.
const script = fileURLToPath(new URL('../scripts/check-release-build.mjs', import.meta.url));

function runCheck(bundle: string, extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'nr-release-check-'));
  const file = join(dir, 'main.js');
  writeFileSync(file, bundle);
  const result = spawnSync(process.execPath, [script, ...extraArgs, file], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const releaseBundle = `
  const worker = 'https://api.noterelay.io';
  const site = 'https://noterelay.io';
  const docs = 'https://developer.mozilla.org/en-US/docs/Web/API';
`;

test('a release bundle is accepted with the Worker origin and the public site', () => {
  const { status, output } = runCheck(releaseBundle);
  assert.equal(status, 0, output);
  assert.match(output, /api\.noterelay\.io/);
});

test('a development Worker origin is refused', () => {
  const { status, output } = runCheck("const w = 'https://noterelay-auth-dev.example.workers.dev'; const s = 'https://noterelay.io';");
  assert.equal(status, 1, output);
  assert.match(output, /development endpoint/);
});

test('two Worker origins are refused even when one of them looks like a release', () => {
  const { status, output } = runCheck("const a = 'https://api.noterelay.io'; const b = 'https://api2.noterelay.io'; const s = 'https://noterelay.io';");
  assert.equal(status, 1, output);
  assert.match(output, /expected one Worker origin/);
});

test('a bundle with no Worker origin is refused', () => {
  const { status, output } = runCheck("const s = 'https://noterelay.io';");
  assert.equal(status, 1, output);
  assert.match(output, /no Worker origin/);
});

test('--allow-development reports a development bundle without failing the build', () => {
  const { status } = runCheck("const w = 'http://localhost:8787'; const s = 'https://noterelay.io';", ['--allow-development']);
  assert.equal(status, 0);
});

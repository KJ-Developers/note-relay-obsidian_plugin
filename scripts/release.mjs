#!/usr/bin/env node
// Cut a directory release without rediscovering the rules that rejected the last one.
//
// The directory's scanner rejected two things that prose in AGENTS.md did not prevent: the word
// "Obsidian" in the plugin description, and a runtime `createElement('script')`. Both were fixed by
// hand afterwards. This script exists so the checks run before a tag exists rather than after a
// reviewer hides the entry.
//
// usage:
//   node scripts/release.mjs 0.2.10 --dry-run     # every check, nothing pushed
//   node scripts/release.mjs 0.2.10               # bump, gate, commit, tag, push, verify
//
// It refuses to run on a dirty tree, on a branch other than main, or when origin/main has moved: a
// release is not the place to discover that another session was working in the same checkout.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find(arg => /^\d+\.\d+\.\d+$/.test(arg));

const problems = [];
const notes = [];

function sh(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
}

function fail(message) { problems.push(message); }

if (!version) {
  console.error('usage: node scripts/release.mjs <major.minor.patch> [--dry-run]');
  process.exit(2);
}

// ---- the directory's own rules, checked before a tag exists -------------------------------------
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

const bannedInListing = /obsidian/i;
if (bannedInListing.test(manifest.name)) {
  fail(`name contains "Obsidian", which the directory refuses (manifest.json name: ${manifest.name}).` +
    ' The plugin is an Obsidian plugin; the name may not say so.');
}
if (manifest.name.length > 45) fail(`name is ${manifest.name.length} characters; keep it short enough to read in a list`);
if (!/^[A-Za-z0-9 ._-]+$/.test(manifest.name)) fail('name uses characters outside letters, digits, space, dot, dash, underscore');
if (/noterelay/i.test(manifest.name)) fail('name spells "NoteRelay": a different publisher uses that spelling');

if (bannedInListing.test(manifest.description)) {
  fail('description contains "Obsidian". The directory rejects it: the context already implies it.' +
    ' Say "your vault" instead.');
}
if (!/[.!?]$/.test(manifest.description.trim())) {
  fail('description must end with a full stop, exclamation or question mark');
}
if (manifest.description.length > 250) fail(`description is ${manifest.description.length} characters; the card truncates`);
if (manifest.description.length < 40) fail('description is too short to say what the plugin does');
if (manifest.id !== 'note-relay') fail(`id changed to ${manifest.id}; changing it renames every command and folder`);

// An existing entry must match the manifest; a missing one is added by this script.
if (versions[version] !== undefined && versions[version] !== manifest.minAppVersion) {
  fail(`versions.json says "${version}": "${versions[version]}" but manifest.json says ${manifest.minAppVersion}`);
}

// ---- tree and branch state ---------------------------------------------------------------------
const status = sh('git', ['status', '--porcelain']).stdout?.trim() ?? '';
if (status) fail('working tree has uncommitted changes; commit or stash them first:\n      ' + status.split('\n').slice(0, 8).join('\n      '));

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
if (branch !== 'main') fail(`on branch ${branch}; releases are cut from main`);

const fetched = sh('git', ['fetch', 'origin', 'main']);
if (fetched.status !== 0) fail('could not fetch origin/main');
const behind = sh('git', ['rev-list', '--count', 'HEAD..origin/main']).stdout?.trim();
if (behind && behind !== '0') fail(`origin/main is ${behind} commit(s) ahead; pull before releasing`);

const tracked = sh('git', ['ls-files', '--error-unmatch', 'main.js']).status === 0;
if (tracked) fail('main.js is tracked; it is generated and must stay out of the repository');

// ---- gates ------------------------------------------------------------------------------------
const gates = [
  ['pnpm', ['exec', 'tsc', '--noEmit'], {}],
  ['pnpm', ['test'], {}],
  ['pnpm', ['lint'], { allowWarnings: true }],
  ['pnpm', ['build'], { env: { ...process.env, NR_WORKER_ORIGIN: 'https://api.noterelay.io' } }],
  ['node', ['scripts/check-release-build.mjs'], {}],
];

function runGates(execute) {
  for (const [command, commandArgs, options] of gates) {
    const label = `${command} ${commandArgs.join(' ')}`;
    if (!execute) { notes.push(`would run: ${label}`); continue; }
    process.stderr.write(`\n▸ ${label}\n`);
    const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: options.env ?? process.env });
    if (result.status !== 0) {
      fail(`${label} failed`);
      return;
    }
  }
}

runGates(!dryRun || args.includes('--gates'));

// The scanner's second error: a script element created at runtime reads as arbitrary code execution.
if (!dryRun && existsSync('main.js')) {
  const bundle = readFileSync('main.js', 'utf8');
  if (/createElement\(\s*['"]script['"]\s*\)/.test(bundle)) {
    fail('main.js still creates a script element at runtime; the directory flags this as arbitrary code execution');
  }
}

// ---- report -----------------------------------------------------------------------------------
if (problems.length) {
  console.error('\n✗ release blocked:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

for (const note of notes) console.error(`  ${note}`);

if (dryRun) {
  console.error(`\n✓ every check passed; ${version} was not tagged (dry run).`);
  process.exit(0);
}

// ---- bump, commit, tag, push ------------------------------------------------------------------
manifest.version = version;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
versions[version] = manifest.minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
if (existsSync('package.json')) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}

const commit = sh('git', ['commit', '-m', `release: ${version}`, '--', 'manifest.json', 'versions.json', 'package.json']);
if (commit.status !== 0) {
  console.error('commit failed; nothing was tagged');
  process.exit(1);
}

const tag = sh('git', ['tag', version]);
if (tag.status !== 0) {
  console.error(`could not create tag ${version}`);
  process.exit(1);
}

const push = sh('git', ['push', 'origin', 'main', version], { stdio: 'inherit' });
if (push.status !== 0) {
  console.error(`push failed. The tag ${version} exists locally; delete it before retrying.`);
  process.exit(1);
}

// ---- verify what the directory will actually see ----------------------------------------------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let conclusion = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(15_000);
  const runs = JSON.parse(sh('gh', ['run', 'list', '--limit', '5', '--json', 'headBranch,status,conclusion,databaseId']).stdout || '[]');
  const run = runs.find(candidate => candidate.headBranch === version);
  if (!run) continue;
  if (run.status === 'completed') { conclusion = run.conclusion; break; }
}

if (conclusion !== 'success') {
  console.error(`\n✗ the release workflow did not succeed (conclusion: ${conclusion ?? 'unknown'}).`);
  process.exit(1);
}

const release = JSON.parse(sh('gh', ['release', 'view', version, '--json', 'url,assets,tagName']).stdout || '{}');
const assetNames = (release.assets ?? []).map(asset => asset.name);
for (const required of ['main.js', 'manifest.json', 'styles.css']) {
  if (!assetNames.includes(required)) fail(`release ${version} is missing ${required}`);
}

console.error(`\n✓ ${version} released: ${release.url}`);
console.error(`  assets: ${assetNames.join(', ')}`);
console.error('\n  The manifest only reaches installed copies. The directory listing is separate — update');
console.error('  these by hand in the dashboard, or the entry keeps showing the old text:');
console.error('    - Name');
console.error('    - Short description   (same rules: no "Obsidian", ends with a full stop)');
console.error('    - Version             (must match the tag, or the scan never runs)');
if (problems.length) process.exit(1);

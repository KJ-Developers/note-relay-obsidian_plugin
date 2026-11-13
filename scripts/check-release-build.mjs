#!/usr/bin/env node
// Refuses a bundle that would ship pointing at a development endpoint.
//
// The plugin's Worker origin is compiled in, so a release build cannot be fixed afterwards by
// configuration — the only defence is to check the artifact before it is published. Run this after
// `NR_WORKER_ORIGIN=… npm run build`.
//
// It reads the bundle's real URLs rather than pattern-matching the whole file, because the bundle
// legitimately contains documentation links from its maths renderer and a `localhost` token inside a
// library's regular expression. A check that fires on those is a check people learn to ignore.
//
// usage: node scripts/check-release-build.mjs [--allow-development] [bundle-path]

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const allowDevelopment = args.includes('--allow-development');
// An explicit path lets a test feed the checker a fixture bundle instead of the real one.
const bundlePath = args.find(arg => !arg.startsWith('--'));
const bundle = readFileSync(bundlePath ?? new URL('../main.js', import.meta.url), 'utf8');

/** Hosts that appear as documentation links in bundled libraries, not as application endpoints. */
const DOCUMENTATION_HOSTS = new Set([
  'www.w3.org', 'en.wikibooks.org', 'github.com', 'mathiasbynens.be', 'tex.stackexchange.com',
  'developer.mozilla.org', 'katex.org', 'temml.org',
]);

/** The public site, which is fixed in `src/endpoints.ts` and expected next to the Worker origin. */
const SITE_HOST = 'noterelay.io';

const hosts = new Set();
for (const match of bundle.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
  const host = match[1].toLowerCase();
  if (!DOCUMENTATION_HOSTS.has(host)) hosts.add(host);
}

// A release bundle legitimately names two hosts: the Worker it talks to and the public site its update
// check reads. Counting both as application origins made a correct production build fail, which is how
// this check first blocked a release. The site is fixed in source, so subtracting it is safe; anything
// else still has to be the single Worker origin.
hosts.delete(SITE_HOST);

const isDevelopment = host => /^localhost$|^127\.0\.0\.1$|^\[::1\]$|(?:^|\.)test$|-dev\.|^dev\./i.test(host);

const problems = [];
if (hosts.size === 0) {
  problems.push('no Worker origin found in the bundle — the build did not define one');
} else if (hosts.size > 1) {
  problems.push(`expected one Worker origin, found ${hosts.size}: ${[...hosts].sort().join(', ')}`);
}

for (const host of hosts) {
  if (isDevelopment(host)) problems.push(`origin ${host} is a development endpoint`);
}

if (problems.length === 0) {
  console.log(`release build OK — single origin ${[...hosts][0]}`);
  process.exit(0);
}

for (const problem of problems) console.error(`  ✗ ${problem}`);
if (allowDevelopment) {
  console.log('development build (--allow-development): the above are expected');
  process.exit(0);
}
console.error('This bundle must not be published. Rebuild with NR_WORKER_ORIGIN set to the release origin.');
process.exit(1);

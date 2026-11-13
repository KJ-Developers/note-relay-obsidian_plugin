import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiagnostics, endpointHost, noteCountBucket } from '../src/diagnostics';

const NOW = Date.parse('2026-11-01T14:12:00Z');

/** The note count as a range, because the exact number is a fact about someone's private vault. */
test('a note count is reported as a range, with inclusive upper bounds', () => {
  assert.equal(noteCountBucket(0), '0');
  assert.equal(noteCountBucket(1), '1–100');
  assert.equal(noteCountBucket(100), '1–100');
  assert.equal(noteCountBucket(101), '100–1k');
  assert.equal(noteCountBucket(1_000), '100–1k');
  assert.equal(noteCountBucket(1_001), '1k–10k');
  assert.equal(noteCountBucket(10_000), '1k–10k');
  assert.equal(noteCountBucket(10_001), '10k+');
  // Nonsense counts must not produce a bucket that reads like a real vault size.
  assert.equal(noteCountBucket(-1), '0');
  assert.equal(noteCountBucket(Number.NaN), '0');
});

test('an endpoint is reduced to its host, never its path or query', () => {
  assert.equal(endpointHost('https://noterelay-auth-dev.example.workers.dev'), 'noterelay-auth-dev.example.workers.dev');
  assert.equal(endpointHost('https://example.test/v1/signal?token=secret'), 'example.test');
  assert.equal(endpointHost(undefined), 'unknown');
  assert.equal(endpointHost('not a url'), 'unknown');
});

test('a complete bundle prints every line in a stable order', () => {
  const text = buildDiagnostics({
    nowMs: NOW, pluginVersion: '0.1.0', protocolVersion: 1, manifestVersion: '0.1.0',
    obsidianVersion: '1.9.14', platform: 'macos', hosting: true, presence: 'active',
    lastClose: { code: 1008, reason: 'vault-busy', at: NOW - 180_000 },
    transport: 'direct', renegotiations: 0, noteCount: 6_704, tagCount: 52,
    view: 'reader', endpoint: 'https://worker.example.test/v1',
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^Note Relay diagnostics — 2026-11-01T14:12:00/);
  assert.match(text, /plugin 0\.1\.0 · protocol 1 · manifest 0\.1\.0/);
  assert.match(text, /obsidian 1\.9\.14 · macos/);
  assert.match(text, /hosting: on · presence: active/);
  // The close line carries the code, the reason word and an age, because those three together are
  // what distinguishes a held vault from a rate limit from a lost network.
  assert.match(text, /last close: 1008 vault-busy · 3 min ago/);
  assert.match(text, /transport: direct · renegotiations: 0/);
  assert.match(text, /vault: 1k–10k notes · tags: 52/);
  assert.match(text, /view: reader/);
  assert.match(text, /endpoint: worker\.example\.test/);
  assert.match(text, /No note titles, paths, folder names, search text or file contents/);
});

test('a missing fact prints unknown rather than dropping its line', () => {
  const text = buildDiagnostics({ nowMs: NOW });
  // A support reader has to be able to tell "not available" from "fine", so a gap is a line.
  assert.match(text, /plugin unknown · protocol unknown/);
  assert.match(text, /obsidian unknown · unknown/);
  assert.match(text, /hosting: unknown · presence: unknown/);
  assert.match(text, /last close: unknown/);
  assert.match(text, /transport: unknown · renegotiations: unknown/);
  assert.match(text, /vault: unknown notes · tags: unknown/);
  assert.match(text, /view: unknown/);
});

test('no close at all is distinguished from an unknown close', () => {
  const none = buildDiagnostics({ nowMs: NOW, lastClose: null });
  assert.match(none, /last close: none this session/);
  const unknown = buildDiagnostics({ nowMs: NOW });
  assert.match(unknown, /last close: unknown/);
});

test('a close with no reason still reports its code', () => {
  const text = buildDiagnostics({ nowMs: NOW, lastClose: { code: 1006, reason: '', at: NOW - 5_000 } });
  assert.match(text, /last close: 1006 · 5s ago/);
});

test('two bundles from the same input differ only in the timestamp', () => {
  const input = {
    pluginVersion: '0.1.0', protocolVersion: 1, hosting: false, presence: 'idle',
    noteCount: 42, tagCount: 3, view: 'obsidian',
  };
  const a = buildDiagnostics({ ...input, nowMs: NOW });
  const b = buildDiagnostics({ ...input, nowMs: NOW + 60_000 });
  assert.notEqual(a, b);
  assert.deepEqual(a.split('\n').slice(1), b.split('\n').slice(1));
});

/**
 * The bundle is the one place in the product where a mistake publishes someone's notes.
 *
 * This test is written against the actual field list rather than banning every string: the close
 * reason is legitimately a word like `vault-busy`, and the platform is legitimately `macos`, so a
 * blanket ban would be a test that passes for the wrong reason.
 *
 * What it proves: every field that would carry note content — and every field that could carry an
 * account or session identifier — is not interpolated verbatim. What it does NOT prove: that a
 * future caller cannot pass note text into a field that is supposed to hold a code word. That is a
 * review matter, not a test.
 */
test('no note content, path, title or query text can reach the bundle', () => {
  const SENTINEL = 'SENTINEL-do-not-leak-8f3a';
  const text = buildDiagnostics({
    nowMs: NOW,
    // Every field a caller could conceivably mistake for a place to put content.
    pluginVersion: '0.1.0', protocolVersion: 1, manifestVersion: '0.1.0',
    obsidianVersion: '1.9.14', platform: 'macos', hosting: true, presence: 'active',
    lastClose: { code: 1008, reason: 'vault-busy', at: NOW - 1_000 },
    transport: 'direct', renegotiations: 1, noteCount: 12, tagCount: 2,
    view: 'reader',
    // A URL is the one free-text-ish field, and only its host may survive.
    endpoint: `https://example.test/${SENTINEL}/note?q=${SENTINEL}`,
  });
  assert.equal(text.includes(SENTINEL), false, 'the URL path and query must not be published');
  assert.match(text, /endpoint: example\.test/);
  // And the bundle states its own guarantee, so a reader is not asked to take it on faith.
  assert.match(text, /No note titles, paths, folder names, search text or file contents/);
});

test('a diagnostic bundle is not a wall of text', () => {
  // It gets pasted into an email by a user and read by one person. Eight content lines plus the
  // header and the guarantee is the budget; growth here means something content-shaped got added.
  const text = buildDiagnostics({
    nowMs: NOW, pluginVersion: '0.1.0', protocolVersion: 1, obsidianVersion: '1.9.14',
    platform: 'macos', hosting: true, presence: 'active',
    lastClose: { code: 1008, reason: 'vault-busy', at: NOW - 1_000 },
    transport: 'direct', renegotiations: 0, noteCount: 500, tagCount: 2, view: 'reader',
  });
  assert.ok(text.split('\n').filter(Boolean).length <= 12, text);
});

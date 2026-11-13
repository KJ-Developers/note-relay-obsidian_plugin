import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataviewGate } from '../src/dataview-gate';
import { installedDataview } from '../src/dataview-api';
import { safeAppearance, safeColor, safeFont } from '../src/appearance';
import { dispatchReadOnly, type VaultAdapter } from '../src/protocol';

test('appearance accepts only named colors and fonts and normalizes rgb', () => {
  assert.equal(safeColor('rgb(30, 41, 59)'), '#1e293b');
  assert.equal(safeColor('rgba(30, 41, 59, 0.5)'), '#1e293b80');
  for (const value of ['red', 'var(--secret)', 'url(https://bad.test/x)', '#123456; color:red', '#12345', 'rgb(999,0,0)']) {
    assert.equal(safeColor(value), null, value);
  }
  assert.equal(safeFont("'Aptos', sans-serif"), "'Aptos', sans-serif");
  assert.equal(safeFont("'Aptos, sans-serif"), null);
  assert.equal(safeFont("Aptos; background:url(https://bad.test/x)"), null);
  assert.deepEqual(safeAppearance({ mode: 'dark', tokens: {
    '--background-primary': 'rgb(30, 41, 59)', '--text-normal': '#ABCDEF',
    '--font-text': "'Aptos', sans-serif", '--text-accent': 'var(--payload)',
    '--table-border-color': '#abc', '--font-interface': 'url(https://bad.test/font)',
  } }), { mode: 'dark', tokens: { '--background-primary': '#1e293b', '--text-normal': '#abcdef', '--table-border-color': '#abc', '--font-text': "'Aptos', sans-serif" } });
});

test('absent, disabled, or initializing Dataview has no callable API', () => {
  assert.equal(installedDataview({}), null);
  assert.equal(installedDataview({ plugins: { plugins: {} } }), null);
  assert.equal(installedDataview({ plugins: { plugins: { dataview: { api: {} } } } }), null);
  const api = { tryQueryMarkdown: async () => 'ok' };
  assert.equal(installedDataview({ plugins: { plugins: { dataview: { api } } } }), api);
});

test('Dataview timeout fails closed and keeps one slot until the underlying query settles', async () => {
  const gate = new DataviewGate(10);
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  await assert.rejects(gate.run(() => pending), /timed out/);
  await assert.rejects(gate.run(async () => 'second'), /busy/);
  finish('late');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await gate.run(async () => 'next'), 'next');
});

test('Dataview rejection and synchronous throw release the slot', async () => {
  const gate = new DataviewGate();
  await assert.rejects(gate.run(async () => { throw new Error('failed'); }), /failed/);
  await assert.rejects(gate.run(() => { throw new Error('threw'); }), /threw/);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('dispatcher validates appearance again before returning it', async () => {
  const adapter: VaultAdapter = {
    listMarkdown: () => [], listFolders: () => [], tags: () => [], backlinks: () => [], outgoing: () => [], getFile: () => null, read: async () => '', readBinary: async () => new ArrayBuffer(0),
    preview: async () => ({ html: '', state: 'complete', renderer: 'test' }),
  searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
  properties: () => [],
    appearance: () => ({ mode: 'dark', tokens: {
      '--text-normal': '#ffffff', '--font-text': 'url(https://bad.test/font)',
    } }),
  };
  assert.deepEqual(await dispatchReadOnly(adapter, true, { version: 1, id: 'appearance', cmd: 'GET_APPEARANCE' }), {
    ok: true, id: 'appearance', data: { mode: 'dark', tokens: { '--text-normal': '#ffffff' } },
  });
});

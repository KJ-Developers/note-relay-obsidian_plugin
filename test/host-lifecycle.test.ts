import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostLifecycle } from '../src/host-lifecycle';
import { dispatchReadOnly, type VaultAdapter } from '../src/protocol';

test('stop and restart never revive a request from the prior host generation', async () => {
  const host = new HostLifecycle();
  assert.equal(host.enabled, false);
  assert.equal(host.sessionId, null);
  host.start();
  const priorSession = host.sessionId;
  assert.match(priorSession!, /^[a-f0-9]{48}$/);
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const adapter: VaultAdapter = {
    listMarkdown: () => [], listFolders: () => [], tags: () => [], backlinks: () => [], outgoing: () => [],
    getFile: path => ({ path, extension: 'md' }),
    read: () => pending, readBinary: async () => new ArrayBuffer(0),
    preview: async () => ({ html: '', state: 'complete', renderer: 'test' }),
  searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
  properties: () => [],
    appearance: () => ({ mode: 'light', tokens: {} }),
  };
  const old = dispatchReadOnly(adapter, host.currentRequest(), { version: 1, id: 'old', cmd: 'READ_MARKDOWN', path: 'Note.md' });
  host.stop();
  host.start();
  assert.notEqual(host.sessionId, priorSession);
  finish('# note');
  assert.deepEqual(await old, { ok: false, id: 'old', error: 'OFFLINE' });
  const fresh = await dispatchReadOnly({ ...adapter, read: async () => '# fresh' }, host.currentRequest(),
    { version: 1, id: 'fresh', cmd: 'READ_MARKDOWN', path: 'Note.md' });
  assert.equal(fresh.ok, true);
  host.stop();
  assert.equal(host.enabled, false);
  assert.equal(host.sessionId, null);
});

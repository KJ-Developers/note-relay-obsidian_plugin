import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthenticatedReadSession, type AuthorizationLease } from '../src/authenticated-read-session';
import { HostLifecycle } from '../src/host-lifecycle';
import { sha256Hex, type VaultAdapter } from '../src/protocol';
import { clientProofMessage } from '../src/peer-grant';
import { ReplyAssembler, type ReplyFrame } from '../src/framing';
import type { WritableChannel } from '../src/framed-channel';

class Channel implements WritableChannel {
  readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function fixture(readMarkdown: () => Promise<string> = async () => '# Welcome') {
  const host = new HostLifecycle(); host.start();
  const worker = await generateKeyPair('ES256');
  const client = await generateKeyPair('ES256', { extractable: true });
  const publicKey = await exportJWK(client.publicKey);
  const expected = { accountId: 'account_1', vaultId: 'vault_1', hostKeyId: 'host_1', entitlementRevision: 3 };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    protocol_version: 1, nonce: 'nonce_1', account_id: expected.accountId,
    vault_id: expected.vaultId, host_key_id: expected.hostKeyId,
    host_session_id: host.sessionId, client_key: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y },
    scope: 'read', entitlement_revision: 3,
  }).setProtectedHeader({ alg: 'ES256', kid: 'worker_1', typ: 'NR-GRANT' })
    .setIssuer('noterelay-worker').setAudience('noterelay-host').setJti('grant_1')
    .setIssuedAt(now).setExpirationTime(now + 120).sign(worker.privateKey);
  const keys = new Map([['worker_1', worker.publicKey]]);
  let reads = 0;
  const adapter: VaultAdapter = {
    listMarkdown: () => [{ path: 'Welcome.md', extension: 'md' }], listFolders: () => [], tags: () => [], backlinks: () => [], outgoing: () => [],
    getFile: path => path === 'Welcome.md' ? { path, extension: 'md' } : null,
    read: async () => { reads++; return readMarkdown(); },
    readBinary: async () => new ArrayBuffer(0),
    preview: async () => ({ html: '<h1>Welcome</h1>', state: 'complete', renderer: 'test' }),
  searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
  properties: () => [],
    appearance: () => ({ mode: 'light', tokens: {} }),
  };
  let lease: AuthorizationLease | null = { expiresAtMs: Date.now() + 60_000, entitlementRevision: 3 };
  const used = new Set<string>();
  const create = () => AuthenticatedReadSession.create(host, adapter, token, keys, expected, used, () => lease);
  const proof = async (session: AuthenticatedReadSession) => {
    const bytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, client.privateKey,
      clientProofMessage('grant_1', session.challenge()));
    return base64url.encode(new Uint8Array(bytes));
  };
  return { host, create, proof, get reads() { return reads; }, setLease: (value: AuthorizationLease | null) => { lease = value; } };
}

const req = { version: 1, id: 'read_1', cmd: 'READ_MARKDOWN', path: 'Welcome.md' };

test('no vault read before client proof; signed peer can send framed result', async () => {
  const f = await fixture();
  const session = await f.create();
  await assert.rejects(session.request(req));
  assert.equal(f.reads, 0);
  await session.prove(await f.proof(session));
  const channel = new Channel();
  await session.send(channel, req);
  const assembler = new ReplyAssembler();
  let reply = null;
  for (const packet of channel.sent) reply = await assembler.add(JSON.parse(packet) as ReplyFrame);
  assert.deepEqual(reply, { ok: true, id: 'read_1',
    data: { path: 'Welcome.md', source: '# Welcome', hash: await sha256Hex('# Welcome') } });
  assert.equal(f.reads, 1);
  f.host.stop();
});

test('lease expiry, revision change, stop and restart deny reads', async () => {
  const f = await fixture();
  const session = await f.create();
  await session.prove(await f.proof(session));
  f.setLease({ expiresAtMs: Date.now() - 1, entitlementRevision: 3 });
  await assert.rejects(session.request(req));
  f.setLease({ expiresAtMs: Date.now() + 60_000, entitlementRevision: 4 });
  await assert.rejects(session.request(req));
  f.setLease(null);
  await assert.rejects(session.request(req));
  assert.equal(f.reads, 0);
  f.host.stop(); f.host.start();
  await assert.rejects(session.request(req));
  await assert.rejects(f.create());
  f.host.stop();
});

test('lease expiring during an in-flight vault read suppresses the reply', async () => {
  let releaseRead: ((source: string) => void) | undefined;
  const heldRead = new Promise<string>(resolve => { releaseRead = resolve; });
  const f = await fixture(() => heldRead);
  const session = await f.create();
  await session.prove(await f.proof(session));
  const channel = new Channel();
  const pending = session.send(channel, req);
  await Promise.resolve();
  assert.equal(f.reads, 1);
  f.setLease({ expiresAtMs: Date.now() - 1, entitlementRevision: 3 });
  releaseRead!('# Private');
  await assert.rejects(pending, /Peer no longer authorized/);
  assert.deepEqual(channel.sent, []);
  f.host.stop();
});

test('one grant cannot open a second authorized session', async () => {
  const f = await fixture();
  const first = await f.create();
  await first.prove(await f.proof(first));
  const second = await f.create();
  await assert.rejects(second.prove(await f.proof(second)));
  assert.equal(f.reads, 0);
  f.host.stop();
});

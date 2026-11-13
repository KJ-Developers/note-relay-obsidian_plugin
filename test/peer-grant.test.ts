import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { acceptClientProof, clientProofMessage, newHostChallenge, verifyPeerGrant } from '../src/peer-grant';

const now = Date.now();
const expected = { accountId: 'owner_1', vaultId: 'vault_1', hostKeyId: 'host_1', hostSessionId: 'session_1', entitlementRevision: 7 };

async function fixture() {
  const worker = await generateKeyPair('ES256', { extractable: true });
  const client = await generateKeyPair('ES256', { extractable: true });
  const clientKey = await exportJWK(client.publicKey);
  const keys = new Map([['worker_1', worker.publicKey]]);
  const claims = {
    account_id: expected.accountId, vault_id: expected.vaultId, host_key_id: expected.hostKeyId,
    host_session_id: expected.hostSessionId,
    protocol_version: 1, nonce: 'nonce_1',
    client_key: { kty: clientKey.kty, crv: clientKey.crv, x: clientKey.x, y: clientKey.y },
    scope: 'read', entitlement_revision: expected.entitlementRevision,
  };
  const sign = async (overrides: Record<string, unknown> = {}, header: Record<string, string> = {}, lifetimeSeconds = 120) =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: 'ES256', typ: 'NR-GRANT', kid: 'worker_1', ...header })
      .setIssuer('noterelay-worker').setAudience('noterelay-host')
      .setJti('grant_1').setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + lifetimeSeconds).sign(worker.privateKey);
  return { worker, client, keys, sign };
}

test('host accepts one signed and client-proven grant', async () => {
  const { client, keys, sign } = await fixture();
  const grant = await verifyPeerGrant(await sign(), keys, expected, now);
  assert.equal(grant.scope, 'read');
  const challenge = newHostChallenge();
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, client.privateKey,
    clientProofMessage(grant.id, challenge));
  const used = new Set<string>();
  await acceptClientProof(grant, challenge, base64url.encode(new Uint8Array(signature)), used, now);
  assert.equal(used.has('grant_1'), true);
  await assert.rejects(acceptClientProof(grant, challenge, base64url.encode(new Uint8Array(signature)), used, now));
});

test('host rejects wrong binding, scope, revision and client key shape', async () => {
  const { keys, sign } = await fixture();
  const token = await sign();
  for (const altered of [
    { ...expected, accountId: 'other' }, { ...expected, vaultId: 'other' },
    { ...expected, hostKeyId: 'other' }, { ...expected, entitlementRevision: 8 },
    { ...expected, hostSessionId: 'after_restart' },
  ]) await assert.rejects(verifyPeerGrant(token, keys, altered, now));
  await assert.rejects(verifyPeerGrant(await sign({ scope: 'admin' }), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({ protocol_version: 2 }), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({ nonce: '' }), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({ client_key: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' } }), keys, expected, now));
});

test('host rejects forged, expired, overlong and unknown-key grants', async () => {
  const { keys, sign } = await fixture();
  const token = await sign();
  const parts = token.split('.');
  parts[1] = `${parts[1][0] === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`;
  await assert.rejects(verifyPeerGrant(parts.join('.'), keys, expected, now));
  await assert.rejects(verifyPeerGrant(token, keys, expected, now + 130_000));
  await assert.rejects(verifyPeerGrant(token + 'x'.repeat(4096), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({}, { kid: 'unknown' }), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({}, { typ: 'JWT' }), keys, expected, now));
  await assert.rejects(verifyPeerGrant(await sign({}, {}, 600), keys, expected, now));
});

test('client proof is bound to host challenge and matching ephemeral key', async () => {
  const { client, keys, sign } = await fixture();
  const grant = await verifyPeerGrant(await sign(), keys, expected, now);
  const challenge = newHostChallenge();
  const otherChallenge = newHostChallenge();
  const proof = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, client.privateKey,
    clientProofMessage(grant.id, challenge));
  const used = new Set<string>();
  await assert.rejects(acceptClientProof(grant, otherChallenge, base64url.encode(new Uint8Array(proof)), used));
  assert.equal(used.size, 0);
  const attacker = await generateKeyPair('ES256');
  const fakeProof = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, attacker.privateKey,
    clientProofMessage(grant.id, challenge));
  await assert.rejects(acceptClientProof(grant, challenge, base64url.encode(new Uint8Array(fakeProof)), used));
  assert.equal(used.size, 0);
  await assert.rejects(acceptClientProof(grant, challenge, base64url.encode(new Uint8Array(proof)), used, now + 130_000));
  assert.equal(used.size, 0);
});

test('concurrent reuse of one grant admits only one proof', async () => {
  const { client, keys, sign } = await fixture();
  const grant = await verifyPeerGrant(await sign(), keys, expected, now);
  const challenge = newHostChallenge();
  const bytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, client.privateKey,
    clientProofMessage(grant.id, challenge));
  const signature = base64url.encode(new Uint8Array(bytes));
  const used = new Set<string>();
  const results = await Promise.allSettled([
    acceptClientProof(grant, challenge, signature, used, now),
    acceptClientProof(grant, challenge, signature, used, now),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(used.size, 1);
});

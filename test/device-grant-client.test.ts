import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceGrantFlow, deviceGrantProofBytes, isUserCode, parsePoll,
} from '../src/device-grant-client';
import type { StoredHostKey } from '../src/pairing-key-store';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (value: string) => Uint8Array.from(
  atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function key(vaultId: string): Promise<StoredHostKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    vaultId, privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string },
  };
}

/** Records what the plugin sent and answers like the Worker does. */
function api(options: { pollAnswers?: unknown[] } = {}) {
  const calls: Array<{ name: string; body: unknown }> = [];
  const grantId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const challenge = b64(crypto.getRandomValues(new Uint8Array(32)));
  const answers = [...(options.pollAnswers ?? [{ status: 'approved',
    accountId: crypto.randomUUID(), email: 'owner@example.com',
    hostKeyId: b64(new Uint8Array(32)) }])];
  return {
    calls, grantId, vaultId, challenge,
    client: {
      async authorize(body: { vaultId: string; hostPublicJwk: unknown; displayLabel: string }) {
        calls.push({ name: 'authorize', body });
        return {
          grantId, challenge,
          deviceCode: b64(crypto.getRandomValues(new Uint8Array(32))),
          userCode: 'ABCDE-FGHJK',
          verificationUrl: 'https://noterelay.io/link',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          interval: 1,
        };
      },
      async present(body: { deviceCode: string; signature: string }) {
        calls.push({ name: 'present', body });
        return { status: 'pending', interval: 1 };
      },
      async token(body: { deviceCode: string }) {
        calls.push({ name: 'token', body });
        return answers.length > 1 ? answers.shift() : answers[0];
      },
    },
  };
}

test('begin proves the vault key over exactly the bytes the Worker verifies', async () => {
  const fake = api();
  const stored = await key(fake.vaultId);
  const flow = new DeviceGrantFlow(fake.client, async () => stored);
  const started = await flow.begin({ vaultId: fake.vaultId, displayLabel: 'Work vault' });

  assert.equal(started.userCode, 'ABCDE-FGHJK');
  assert.equal(started.verificationUrl, 'https://noterelay.io/link');
  assert.equal(fake.calls[0].name, 'authorize');
  assert.deepEqual((fake.calls[0].body as { displayLabel: string }).displayLabel, 'Work vault');

  // The signature must verify against the public key over the same framing the Worker builds.
  const signature = (fake.calls[1].body as { signature: string }).signature;
  const publicKey = await crypto.subtle.importKey('jwk', stored.publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
    unb64(signature), deviceGrantProofBytes({
      grantId: fake.grantId, vaultId: fake.vaultId, challenge: fake.challenge,
    }));
  assert.equal(valid, true, 'the proof the plugin sends must be the proof the Worker checks');
});

test('begin refuses to show a code when the host proof is rejected', async () => {
  const fake = api();
  const stored = await key(fake.vaultId);
  const rejecting = { ...fake.client, present: async () => ({ status: 'rejected' }) };
  const flow = new DeviceGrantFlow(rejecting, async () => stored);
  await assert.rejects(() => flow.begin({ vaultId: fake.vaultId, displayLabel: 'x' }),
    /not accepted/);
});

test('wait returns as soon as the owner approves, and does not poll forever', async () => {
  const fake = api({ pollAnswers: [
    { status: 'pending' }, { status: 'pending' }, { status: 'approved',
      accountId: crypto.randomUUID(), email: 'owner@example.com',
      hostKeyId: b64(new Uint8Array(32)) },
  ] });
  const stored = await key(fake.vaultId);
  const flow = new DeviceGrantFlow(fake.client, async () => stored);
  const started = await flow.begin({ vaultId: fake.vaultId, displayLabel: 'x' });
  const answer = await flow.wait({ ...started, intervalSeconds: 0 });
  assert.equal(answer.state, 'approved');
  assert.equal(fake.calls.filter(call => call.name === 'token').length, 3);
});

test('an expired offer ends the wait instead of spinning', async () => {
  const fake = api({ pollAnswers: [{ status: 'pending' }] });
  const stored = await key(fake.vaultId);
  let clock = Date.now();
  const flow = new DeviceGrantFlow(fake.client, async () => stored, () => clock);
  const started = await flow.begin({ vaultId: fake.vaultId, displayLabel: 'x' });
  clock = started.expiresAtMs + 1;
  const answer = await flow.wait({ ...started, intervalSeconds: 0 });
  assert.equal(answer.state, 'expired');
  assert.equal(fake.calls.filter(call => call.name === 'token').length, 0);
});

test('an approved poll without a usable account is rejected, not trusted', () => {
  assert.throws(() => parsePoll({ status: 'approved', accountId: 'nope',
    email: 'a@b.c', hostKeyId: 'A'.repeat(43) }), /Invalid grant poll/);
  assert.throws(() => parsePoll({ status: 'approved', accountId: crypto.randomUUID(),
    email: '', hostKeyId: 'A'.repeat(43) }), /Invalid grant poll/);
  assert.deepEqual(parsePoll({ status: 'spent' }), { state: 'spent' });
  assert.deepEqual(parsePoll({ status: 'awaiting_host' }), { state: 'pending' });
});

test('the settings pane can tell a well-formed code from nonsense', () => {
  assert.equal(isUserCode('ABCDE-FGHJK'), true);
  assert.equal(isUserCode('abcde-fghjk'), false, 'normalising is the page\'s job, not the shape test');
  assert.equal(isUserCode('ABCDE-FGHJ0'), false);
});

test('a poll that is rate limited waits instead of ending the connection attempt', async () => {
  // Measured 2026-11-06: polling spent the same budget as creating grants, so a normal five-second
  // wait answered 429 after about a hundred seconds and the dialog reported a failure.
  let calls = 0;
  const api = {
    authorize: async () => { throw new Error('unused'); },
    present: async () => ({ status: 'pending' }),
    token: async () => {
      calls += 1;
      if (calls === 1) {
        const refusal = new Error('Too many connection attempts from this network.') as Error & {
          status: number; retryAfterSeconds: number };
        refusal.status = 429;
        refusal.retryAfterSeconds = 1;
        throw refusal;
      }
      return { status: 'approved', accountId: crypto.randomUUID(), email: 'e@example.test',
        hostKeyId: 'k'.repeat(43), vaultId: crypto.randomUUID() };
    },
  };
  const flow = new DeviceGrantFlow(api);
  const started = { deviceCode: 'd'.repeat(43), userCode: 'ABCDE-FGHIJ',
    verificationUrl: 'https://noterelay.io/link', intervalSeconds: 1,
    expiresAtMs: Date.now() + 30_000, grantId: 'g', challenge: 'c'.repeat(43) };
  const answer = await flow.wait(started);
  assert.equal(answer.state, 'approved');
  assert.equal(calls, 2);
});

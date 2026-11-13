import assert from 'node:assert/strict';
import test from 'node:test';
import { requestUrlState } from './obsidian-stub';
import { DeviceApiError, deviceApi } from '../src/device-api';

function reply(status: number, body: unknown) {
  requestUrlState.response = { status, text: JSON.stringify(body) };
}

test('a rate limit says how long to wait, because that is the only useful fact', async () => {
  reply(429, { error: 'RATE_LIMITED', retryAfterSeconds: 420 });
  await assert.rejects(
    () => deviceApi.authorize({ vaultId: 'v', hostPublicJwk: {}, displayLabel: 'd' }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceApiError);
      assert.match(error.message, /too many connection attempts/i);
      assert.match(error.message, /7 minutes/);
      assert.equal(error.retryAfterSeconds, 420);
      return true;
    });
});

test('a refusal with no wait does not invent a precise number', async () => {
  reply(429, { error: 'RATE_LIMITED' });
  await assert.rejects(
    () => deviceApi.authorize({ vaultId: 'v', hostPublicJwk: {}, displayLabel: 'd' }),
    (error: unknown) => {
      assert.match((error as Error).message, /10 minutes/);
      assert.equal((error as DeviceApiError).retryAfterSeconds, undefined);
      return true;
    });
});

test('a 404 points at the likely cause instead of a generic failure', async () => {
  reply(404, { error: 'UNAVAILABLE' });
  await assert.rejects(
    () => deviceApi.authorize({ vaultId: 'v', hostPublicJwk: {}, displayLabel: 'd' }),
    /already connected/i);
});

test('an unreadable body is reported as unreachable, not as a bad code', async () => {
  requestUrlState.response = { status: 502, text: 'no' };
  await assert.rejects(
    () => deviceApi.authorize({ vaultId: 'v', hostPublicJwk: {}, displayLabel: 'd' }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceApiError);
      assert.equal(error.code, 'UNREADABLE');
      return true;
    });
});

test('a rejected proof is a state, not an exception', async () => {
  reply(403, { error: 'PROOF_REJECTED' });
  assert.deepEqual(await deviceApi.present({ deviceCode: 'd', signature: 's' }), { status: 'rejected' });
});

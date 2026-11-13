import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingFlow } from '../src/pairing-flow';
import { generateHostPairingKey } from '../src/pairing-key';

function fixture() {
  const accountId = crypto.randomUUID();
  const pairingId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const calls: string[] = [];
  let approved = false;
  const api = {
    async lookup(code: string) {
      calls.push(`lookup:${code}`);
      return { accountId, pairingId, challenge,
        accountEmail: 'owner@example.invalid',
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    async present(input: { signature: string }) {
      calls.push('present');
      assert.equal(input.signature.length, 86);
      return true;
    },
    async confirm(input: { pairingId: string; signature: string }) {
      calls.push('confirm');
      assert.equal(input.pairingId, pairingId);
      assert.equal(input.signature.length, 86);
      return approved;
    },
  };
  const flow = new PairingFlow(api, async id => {
    assert.equal(id, vaultId);
    const generated = await generateHostPairingKey();
    return { vaultId: id, ...generated };
  });
  return { flow, vaultId, calls, approve() { approved = true; } };
}

test('review precedes a separate local confirmation and browser approval', async () => {
  const f = fixture();
  await assert.rejects(f.flow.confirm());
  const review = await f.flow.review('ABCDE-FGHIJ', f.vaultId, 'Test vault');
  assert.equal(review.accountEmail, 'owner@example.invalid');
  assert.equal(review.hostKeyId.length, 43);
  assert.deepEqual(f.calls, ['lookup:ABCDE-FGHIJ', 'present']);
  assert.equal(await f.flow.confirm(), false);
  f.approve();
  assert.equal(await f.flow.confirm(), true);
  await assert.rejects(f.flow.confirm());
  assert.deepEqual(f.calls, ['lookup:ABCDE-FGHIJ', 'present', 'confirm', 'confirm']);
});

test('invalid lookup and cancellation never sign or confirm', async () => {
  const f = fixture();
  await assert.rejects(f.flow.review('bad', f.vaultId, 'Test vault'));
  assert.deepEqual(f.calls, []);
  f.flow.cancel();
  await assert.rejects(f.flow.confirm());
  const badApi = {
    async lookup() { return { accountEmail: 'owner@example.invalid' }; },
    async present() { throw new Error('must not present'); },
    async confirm() { throw new Error('must not confirm'); },
  };
  const flow = new PairingFlow(badApi);
  await assert.rejects(flow.review('ABCDE-FGHIJ', f.vaultId, 'Test vault'));
});

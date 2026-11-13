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
  const presents: Array<Record<string, unknown>> = [];
  let approved = false;
  const api = {
    async lookup(code: string) {
      calls.push(`lookup:${code}`);
      return { accountId, pairingId, challenge,
        accountEmail: 'owner@example.invalid',
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    async present(input: { signature: string; deviceId?: string; machineLabel?: string }) {
      calls.push('present');
      presents.push(input);
      assert.equal(input.signature.length, 86);
      return { ok: true, status: 200 };
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
  return { flow, vaultId, calls, presents, approve() { approved = true; } };
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

test('presents the machine identity so a reinstall can retire its own earlier row', async () => {
  const f = fixture();
  const deviceId = crypto.randomUUID();
  await f.flow.review('ABCDE-FGHIJ', f.vaultId, 'Test vault',
    { deviceId, machineLabel: 'Davids-Mac-Studio-2' });
  assert.equal(f.presents.length, 1);
  assert.equal(f.presents[0].deviceId, deviceId);
  assert.equal(f.presents[0].machineLabel, 'Davids-Mac-Studio-2');
  // The signed bytes are unchanged: the device id is not part of the host proof, so an older Worker
  // that ignores it still verifies the same signature.
  assert.equal((f.presents[0].signature as string).length, 86);
});

test('omits the machine label when the host has none, and sends no device fields at all without one', async () => {
  const f = fixture();
  await f.flow.review('ABCDE-FGHIJ', f.vaultId, 'Test vault',
    { deviceId: crypto.randomUUID(), machineLabel: null });
  assert.equal('machineLabel' in f.presents[0], false);

  const g = fixture();
  await g.flow.review('ABCDE-FGHIJ', g.vaultId, 'Test vault');
  assert.equal('deviceId' in g.presents[0], false);
  assert.equal('machineLabel' in g.presents[0], false);
});

test('pairs without the device fields when the Worker predates them', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const api = {
    async lookup(code: string) {
      return { accountId: crypto.randomUUID(), pairingId: crypto.randomUUID(),
        challenge: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        accountEmail: 'owner@example.invalid',
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    // The first body carries keys this Worker does not expect, which is what an older build answers.
    async present(input: Record<string, unknown>) {
      seen.push(input);
      return 'deviceId' in input ? { ok: false, status: 400 } : { ok: true, status: 200 };
    },
    async confirm() { return true; },
  };
  const vaultId = crypto.randomUUID();
  const flow = new PairingFlow(api, async id => ({ vaultId: id, ...await generateHostPairingKey() }));
  const review = await flow.review('ABCDE-FGHIJ', vaultId, 'Test vault',
    { deviceId: crypto.randomUUID(), machineLabel: 'Some-Machine' });
  assert.equal(review.vaultLabel, 'Test vault');
  assert.equal(seen.length, 2);
  assert.equal('deviceId' in seen[0], true);
  assert.equal('deviceId' in seen[1], false);
});

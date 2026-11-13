import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { getExistingHostKey, getOrCreateHostKey, replaceHostKey } from '../src/pairing-key-store';
import { hostPairingKeyId } from '../src/pairing-key';

test('host key survives reload and concurrent creation uses one identity', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const values = await Promise.all(Array.from({ length: 3 },
    () => getOrCreateHostKey(vaultId, factory)));
  const reloaded = await getOrCreateHostKey(vaultId, factory);
  for (const value of values) assert.deepEqual(value.publicJwk, reloaded.publicJwk);
  assert.equal(reloaded.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', reloaded.privateKey));
  const otherVault = await getOrCreateHostKey(crypto.randomUUID(), factory);
  assert.notDeepEqual(otherVault.publicJwk, reloaded.publicJwk);
});

test('corrupt persisted key fails closed instead of being replaced', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const request = factory.open('noterelay-host-keys', 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('keys', 'readwrite');
    transaction.objectStore('keys').put({ ...original, publicJwk: { ...original.publicJwk, x: 'bad' } });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('put failed'));
  });
  db.close();
  await assert.rejects(getOrCreateHostKey(vaultId, factory), /Invalid stored host key/);
});

test('explicit replacement changes only the matching vault key and survives reload', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  assert.equal(await getExistingHostKey(vaultId, factory), null);
  const original = await getOrCreateHostKey(vaultId, factory);
  const other = await getOrCreateHostKey(otherVaultId, factory);
  const fingerprint = await hostPairingKeyId(original.publicJwk);
  await assert.rejects(replaceHostKey(vaultId, 'A'.repeat(43), factory), /Host key changed/);
  assert.deepEqual((await getExistingHostKey(vaultId, factory))?.publicJwk, original.publicJwk);
  const replacement = await replaceHostKey(vaultId, fingerprint, factory);
  assert.notDeepEqual(replacement.publicJwk, original.publicJwk);
  assert.equal(replacement.privateKey.extractable, false);
  assert.deepEqual((await getOrCreateHostKey(vaultId, factory)).publicJwk, replacement.publicJwk);
  assert.deepEqual((await getOrCreateHostKey(otherVaultId, factory)).publicJwk, other.publicJwk);
  await assert.rejects(replaceHostKey(vaultId, fingerprint, factory), /Host key changed/);
});

test('concurrent replacements cannot both overwrite the same fingerprint', async () => {
  const factory = new IDBFactory();
  const vaultId = crypto.randomUUID();
  const original = await getOrCreateHostKey(vaultId, factory);
  const fingerprint = await hostPairingKeyId(original.publicJwk);
  const outcomes = await Promise.allSettled([
    replaceHostKey(vaultId, fingerprint, factory),
    replaceHostKey(vaultId, fingerprint, factory),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  const winner = outcomes.find(item => item.status === 'fulfilled');
  assert.equal(winner?.status, 'fulfilled');
  assert.deepEqual((await getExistingHostKey(vaultId, factory))?.publicJwk, winner.value.publicJwk);
});

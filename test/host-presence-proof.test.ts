import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signPresence, presenceBytes } from '../src/host-presence-proof';

test('host signs a domain-separated presence action bound to vault and session', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const vaultId = 'b1a0f81c-208b-4ecf-b49e-9bb95aa94382';
  const proof = await signPresence('renew', vaultId, 'a'.repeat(48), pair.privateKey);
  const signature = Uint8Array.from(atob(proof.signature.replace(/-/g, '+').replace(/_/g, '/')),
    character => character.charCodeAt(0));
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey, signature, presenceBytes(proof)), true);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey, signature, presenceBytes({ ...proof, action: 'stop' })), false);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey, signature, presenceBytes({ ...proof, hostSessionId: 'b'.repeat(48) })), false);
});

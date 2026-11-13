import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateHostPairingKey, signHostPairingConfirmation, signHostPairingProof,
} from '../src/pairing-key';

test('host pairing private key stays non-extractable and signatures are domain separated', async () => {
  const { privateKey, publicJwk } = await generateHostPairingKey();
  assert.equal(privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', privateKey));
  assert.deepEqual(Object.keys(publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  const context = {
    accountId: crypto.randomUUID(), pairingId: crypto.randomUUID(),
    vaultId: crypto.randomUUID(),
    challenge: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  };
  const verifyKey = await crypto.subtle.importKey('jwk', publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const proof = await signHostPairingProof(privateKey, context);
  const confirmation = await signHostPairingConfirmation(privateKey, context);
  const proofMessage = new TextEncoder().encode([
    'noterelay:host-pairing:v1', context.accountId.toLowerCase(),
    context.pairingId.toLowerCase(), context.vaultId.toLowerCase(), context.challenge,
  ].join('\n'));
  const confirmMessage = new TextEncoder().encode(`noterelay:host-pairing-confirm:v1\n${new TextDecoder().decode(proofMessage)}`);
  const decode = (value: string) => Buffer.from(value, 'base64url');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    verifyKey, decode(proof), proofMessage), true);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    verifyKey, decode(confirmation), confirmMessage), true);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    verifyKey, decode(proof), confirmMessage), false);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    verifyKey, decode(confirmation), proofMessage), false);
  await assert.rejects(signHostPairingProof(privateKey, { ...context, challenge: 'bad' }));
});

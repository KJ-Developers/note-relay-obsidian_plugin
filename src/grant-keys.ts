// Public development Worker key only. Rotate with a bounded overlap before
// production; the corresponding private key lives only in Cloudflare secrets.
export const pinnedGrantPublicJwks = {
  nrdev20261025: {
    kty: 'EC', crv: 'P-256',
    x: 'hmWu1l9902mNHBJVBrZYJnjRnpvEXG4pJhZYsmqn8hw',
    y: 'MDmRbs1bhT7GOwihrS8PKu1Aga-fBVzsvIW0MjokhUo',
  },
} as const;

export async function importPinnedGrantKeys(): Promise<ReadonlyMap<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  for (const [id, jwk] of Object.entries(pinnedGrantPublicJwks)) {
    keys.set(id, await crypto.subtle.importKey('jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  return keys;
}

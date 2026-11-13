// Host key operations for the eventual explicit Obsidian pairing screen.
// The private key is non-extractable. Persistence and key-loss recovery are
// separate work; never serialize it into plugin settings or send it to cloud.
export type HostPublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };
export type PairingContext = {
  accountId: string; pairingId: string; vaultId: string; challenge: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const challenge = /^[A-Za-z0-9_-]{43}$/;

function encode(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function proofBytes(context: PairingContext): Uint8Array<ArrayBuffer> {
  if (!uuid.test(context.accountId) || !uuid.test(context.pairingId) ||
      !uuid.test(context.vaultId) || !challenge.test(context.challenge)) {
    throw new Error('Invalid pairing context');
  }
  return new TextEncoder().encode([
    'noterelay:host-pairing:v1', context.accountId.toLowerCase(),
    context.pairingId.toLowerCase(), context.vaultId.toLowerCase(),
    context.challenge,
  ].join('\n'));
}

export async function generateHostPairingKey(): Promise<{
  privateKey: CryptoKey; publicJwk: HostPublicJwk;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' ||
      typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string') {
    throw new Error('Invalid generated host key');
  }
  return { privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y } };
}

export async function hostPairingKeyId(publicJwk: HostPublicJwk): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  void key;
  const decode = (value: string) => Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const publicBytes = new Uint8Array(65);
  publicBytes[0] = 4;
  publicBytes.set(decode(publicJwk.x), 1);
  publicBytes.set(decode(publicJwk.y), 33);
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', publicBytes)));
}

export async function signHostPairingProof(key: CryptoKey, context: PairingContext): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, proofBytes(context));
  return encode(new Uint8Array(signature));
}

export async function signHostPairingConfirmation(key: CryptoKey, context: PairingContext): Promise<string> {
  const prefix = new TextEncoder().encode('noterelay:host-pairing-confirm:v1\n');
  const proof = proofBytes(context);
  const bytes = new Uint8Array(prefix.length + proof.length);
  bytes.set(prefix);
  bytes.set(proof, prefix.length);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes);
  return encode(new Uint8Array(signature));
}

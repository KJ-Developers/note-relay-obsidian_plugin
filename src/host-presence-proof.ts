const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = /^[0-9a-f]{48}$/;

export type PresenceAction = 'renew' | 'stop';
export type PresenceProof = {
  action: PresenceAction; vaultId: string; hostSessionId: string;
  issuedAtMs: number; nonce: string; signature: string;
};

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function presenceBytes(proof: Omit<PresenceProof, 'signature'>): Uint8Array<ArrayBuffer> {
  if (!UUID.test(proof.vaultId) || !SESSION.test(proof.hostSessionId) ||
      !Number.isSafeInteger(proof.issuedAtMs) ||
      !/^[A-Za-z0-9_-]{22}$/.test(proof.nonce) ||
      (proof.action !== 'renew' && proof.action !== 'stop')) throw new Error('Invalid presence input');
  return new TextEncoder().encode([
    'noterelay:host-presence:v1', proof.action, proof.vaultId.toLowerCase(),
    proof.hostSessionId, String(proof.issuedAtMs), proof.nonce,
  ].join('\n'));
}

export async function signPresence(action: PresenceAction, vaultId: string,
  hostSessionId: string, key: CryptoKey, issuedAtMs = Date.now()): Promise<PresenceProof> {
  const unsigned = { action, vaultId, hostSessionId, issuedAtMs,
    nonce: encode(crypto.getRandomValues(new Uint8Array(16))) };
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    key, presenceBytes(unsigned));
  return { ...unsigned, signature: encode(new Uint8Array(signature)) };
}

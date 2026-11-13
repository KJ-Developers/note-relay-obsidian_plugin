import type { StoredHostKey } from './pairing-key-store';

export type HostSignalProof = {
  vaultId: string; hostSessionId: string; issuedAtMs: number;
  nonce: string; signature: string;
};

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function proofBytes(proof: Omit<HostSignalProof, 'signature'>,
  purpose: 'signal' | 'turn'): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.vaultId) ||
      !/^[0-9a-f]{48}$/.test(proof.hostSessionId) ||
      !Number.isSafeInteger(proof.issuedAtMs) ||
      !/^[A-Za-z0-9_-]{22}$/.test(proof.nonce)) throw new Error('Invalid signal proof');
  return new TextEncoder().encode([
    `noterelay:host-${purpose}:v1`, proof.vaultId.toLowerCase(),
    proof.hostSessionId, String(proof.issuedAtMs), proof.nonce,
  ].join('\n'));
}

export function hostSignalBytes(proof: Omit<HostSignalProof, 'signature'>): Uint8Array<ArrayBuffer> {
  return proofBytes(proof, 'signal');
}

export function hostTurnBytes(proof: Omit<HostSignalProof, 'signature'>): Uint8Array<ArrayBuffer> {
  return proofBytes(proof, 'turn');
}

export async function signHostSignalProof(vaultId: string, hostSessionId: string,
  key: StoredHostKey, issuedAtMs = Date.now()): Promise<HostSignalProof> {
  return signProof(vaultId, hostSessionId, key, hostSignalBytes, issuedAtMs);
}

export async function signHostTurnProof(vaultId: string, hostSessionId: string,
  key: StoredHostKey, issuedAtMs = Date.now()): Promise<HostSignalProof> {
  return signProof(vaultId, hostSessionId, key, hostTurnBytes, issuedAtMs);
}

async function signProof(vaultId: string, hostSessionId: string, key: StoredHostKey,
  bytes: typeof hostSignalBytes, issuedAtMs: number): Promise<HostSignalProof> {
  const unsigned = { vaultId, hostSessionId, issuedAtMs,
    nonce: encode(crypto.getRandomValues(new Uint8Array(16))) };
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey, bytes(unsigned));
  return { ...unsigned, signature: encode(new Uint8Array(signature)) };
}

export function encodeHostSignalProof(proof: HostSignalProof): string {
  return encode(new TextEncoder().encode(JSON.stringify(proof)));
}

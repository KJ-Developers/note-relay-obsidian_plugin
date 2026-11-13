import { base64url, jwtVerify, type JWK } from 'jose';

const ISSUER = 'noterelay-worker';
const AUDIENCE = 'noterelay-host';
const MAX_GRANT_CHARS = 4096;
const MAX_GRANT_SECONDS = 120;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * `read` sees the vault; `owner_write` and `write` may change it.
 *
 * `write` is the guest tier's scope: a shared vault where the owner granted edit. It is accepted here
 * now, while sharing is still unbuilt, so that the plugin does not need another release on the day the
 * Worker starts minting it — a manual install is the expensive part of shipping this product today.
 */
export type GrantScope = 'read' | 'owner_write' | 'write';
export type PeerGrant = {
  accountId: string;
  vaultId: string;
  hostKeyId: string;
  hostSessionId: string;
  clientKey: JWK;
  scope: GrantScope;
  entitlementRevision: number;
  id: string;
  nonce: string;
  expiresAt: number;
};

export type ExpectedGrant = {
  accountId: string;
  vaultId: string;
  hostKeyId: string;
  hostSessionId: string;
  entitlementRevision: number;
};

function validClientKey(value: unknown): value is JWK {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return Object.keys(key).sort().join(',') === 'crv,kty,x,y' &&
    key.kty === 'EC' && key.crv === 'P-256' &&
    typeof key.x === 'string' && COORDINATE.test(key.x) &&
    typeof key.y === 'string' && COORDINATE.test(key.y);
}

// Public keys are pinned by the plugin's trusted configuration. A caller may
// select a known kid, but cannot provide a signing key or change the algorithm.
export async function verifyPeerGrant(
  token: string, keys: ReadonlyMap<string, CryptoKey>, expected: ExpectedGrant, nowMs = Date.now(),
): Promise<PeerGrant> {
  if (typeof token !== 'string' || token.length > MAX_GRANT_CHARS) throw new Error('Invalid grant');
  const { payload, protectedHeader } = await jwtVerify(token, header => {
    if (header.alg !== 'ES256' || header.typ !== 'NR-GRANT' ||
      typeof header.kid !== 'string' || !KEY_ID.test(header.kid)) throw new Error('Invalid grant header');
    const key = keys.get(header.kid);
    if (!key) throw new Error('Unknown grant key');
    return key;
  }, {
    issuer: ISSUER, audience: AUDIENCE, algorithms: ['ES256'],
    currentDate: new Date(nowMs), clockTolerance: 5,
  });
  if (protectedHeader.typ !== 'NR-GRANT' ||
    !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
    payload.exp! <= payload.iat! || payload.exp! - payload.iat! > MAX_GRANT_SECONDS ||
    payload.iat! > Math.floor(nowMs / 1000) + 5 ||
    typeof payload.jti !== 'string' || !ID.test(payload.jti) ||
    payload.protocol_version !== 1 ||
    typeof payload.nonce !== 'string' || !ID.test(payload.nonce) ||
    typeof payload.account_id !== 'string' || !ID.test(payload.account_id) ||
    typeof payload.vault_id !== 'string' || !ID.test(payload.vault_id) ||
    typeof payload.host_key_id !== 'string' || !ID.test(payload.host_key_id) ||
    typeof payload.host_session_id !== 'string' || !ID.test(payload.host_session_id) ||
    !validClientKey(payload.client_key) ||
    (payload.scope !== 'read' && payload.scope !== 'owner_write' && payload.scope !== 'write') ||
    !Number.isSafeInteger(payload.entitlement_revision) ||
    (payload.entitlement_revision as number) < 0 ||
    payload.account_id !== expected.accountId || payload.vault_id !== expected.vaultId ||
    payload.host_key_id !== expected.hostKeyId ||
    payload.host_session_id !== expected.hostSessionId ||
    payload.entitlement_revision !== expected.entitlementRevision) throw new Error('Invalid grant claims');
  return {
    accountId: payload.account_id,
    vaultId: payload.vault_id,
    hostKeyId: payload.host_key_id,
    hostSessionId: payload.host_session_id,
    clientKey: payload.client_key,
    scope: payload.scope,
    entitlementRevision: payload.entitlement_revision,
    id: payload.jti,
    nonce: payload.nonce,
    expiresAt: payload.exp!,
  };
}

export function newHostChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function clientProofMessage(grantId: string, hostChallenge: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!ID.test(grantId) || !(hostChallenge instanceof Uint8Array) || hostChallenge.length !== 32) {
    throw new Error('Invalid challenge');
  }
  return Uint8Array.from(new TextEncoder().encode(`noterelay/client-proof/v1\n${grantId}\n${base64url.encode(hostChallenge)}`));
}

// Called once after the host has generated and sent a fresh challenge. The
// caller owns `usedGrantIds` for the lifetime of the host process/session.
export async function acceptClientProof(
  grant: PeerGrant, hostChallenge: Uint8Array, signature: string, usedGrantIds: Set<string>, nowMs = Date.now(),
): Promise<void> {
  if (usedGrantIds.has(grant.id) || nowMs >= grant.expiresAt * 1000 + 5000 ||
    typeof signature !== 'string' || signature.length > 128) {
    throw new Error('Invalid client proof');
  }
  // Reserve before the first await so two concurrent proofs cannot both pass.
  usedGrantIds.add(grant.id);
  try {
    const key = await crypto.subtle.importKey('jwk', grant.clientKey,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const bytes = base64url.decode(signature);
    if (bytes.length !== 64 || !await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(bytes), clientProofMessage(grant.id, hostChallenge),
    )) throw new Error('Invalid client proof');
  } catch {
    usedGrantIds.delete(grant.id);
    throw new Error('Invalid client proof');
  }
}

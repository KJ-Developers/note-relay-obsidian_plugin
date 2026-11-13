import { getOrCreateHostKey, type StoredHostKey } from './pairing-key-store';
import type { HostPublicJwk } from './pairing-key';
import { wait } from './timers';

/**
 * The plugin's half of the device grant.
 *
 * The vault starts the conversation: it asks the Worker for a grant, signs the challenge it gets
 * back with its pairing key, and then shows a short code. The owner approves that code in a browser
 * — signing in or creating an account there, which is where the invite requirement lives. This
 * module never sees a password, a session token, or an account session; the result is a binding.
 */

const GRANT_PREFIX = 'noterelay:device-grant:v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const challengeValue = /^[A-Za-z0-9_-]{43}$/;
const userCodeValue = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;
const signatureValue = /^[A-Za-z0-9_-]{86}$/;

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Must match the Worker byte for byte: grant id, vault id, challenge. */
export function deviceGrantProofBytes(input: {
  grantId: string; vaultId: string; challenge: string;
}): Uint8Array<ArrayBuffer> {
  if (!uuid.test(input.grantId) || !uuid.test(input.vaultId) ||
      !challengeValue.test(input.challenge)) throw new Error('Invalid grant context');
  return new TextEncoder().encode([
    GRANT_PREFIX, input.grantId.toLowerCase(), input.vaultId.toLowerCase(), input.challenge,
  ].join('\n'));
}

async function signProof(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, bytes)));
}

export type DeviceApi = {
  authorize(input: {
    vaultId: string; hostPublicJwk: HostPublicJwk; displayLabel: string;
  }): Promise<unknown>;
  present(input: { deviceCode: string; signature: string }): Promise<unknown>;
  token(input: { deviceCode: string }): Promise<unknown>;
};

export type Started = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAtMs: number;
  intervalSeconds: number;
};

export type Polled =
  | { state: 'pending' }
  | { state: 'approved'; accountId: string; email: string; hostKeyId: string }
  | { state: 'expired' }
  | { state: 'spent' };

function parseAuthorize(value: unknown): {
  grantId: string; challenge: string; deviceCode: string; userCode: string;
  verificationUrl: string; expiresAtMs: number; intervalSeconds: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid grant response');
  }
  const row = value as Record<string, unknown>;
  const expected = 'challenge,deviceCode,expiresAt,grantId,interval,userCode,verificationUrl';
  if (Object.keys(row).sort().join(',') !== expected ||
      typeof row.grantId !== 'string' || !uuid.test(row.grantId) ||
      typeof row.challenge !== 'string' || !challengeValue.test(row.challenge) ||
      typeof row.deviceCode !== 'string' || row.deviceCode.length !== 43 ||
      typeof row.userCode !== 'string' || !userCodeValue.test(row.userCode) ||
      typeof row.verificationUrl !== 'string' || !/^https:\/\//.test(row.verificationUrl) ||
      typeof row.expiresAt !== 'string' || typeof row.interval !== 'number') {
    throw new Error('Invalid grant response');
  }
  const expiresAtMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('Grant expired');
  }
  return {
    grantId: row.grantId, challenge: row.challenge, deviceCode: row.deviceCode,
    userCode: row.userCode, verificationUrl: row.verificationUrl,
    expiresAtMs, intervalSeconds: Math.min(Math.max(row.interval, 1), 60),
  };
}

export function parsePoll(value: unknown): Polled {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid grant poll');
  const row = value as Record<string, unknown>;
  if (row.status === 'awaiting_host' || row.status === 'pending') return { state: 'pending' };
  if (row.status === 'expired' || row.status === 'spent') return { state: row.status };
  if (row.status === 'approved') {
    if (typeof row.accountId !== 'string' || !uuid.test(row.accountId) ||
        typeof row.email !== 'string' || row.email.length < 3 ||
        typeof row.hostKeyId !== 'string' || !challengeValue.test(row.hostKeyId)) {
      throw new Error('Invalid grant poll');
    }
    return { state: 'approved', accountId: row.accountId, email: row.email,
      hostKeyId: row.hostKeyId };
  }
  throw new Error('Invalid grant poll');
}

export class DeviceGrantFlow {
  private busy = false;

  constructor(
    private readonly api: DeviceApi,
    private readonly keyStore: (vaultId: string) => Promise<StoredHostKey> = getOrCreateHostKey,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Asks for a grant, proves the vault's key, and returns what the settings pane shows.
   *
   * Both calls are necessary: the challenge comes from the Worker so a captured proof cannot be
   * replayed into a different grant, and the proof is what makes the code belong to this vault.
   */
  async begin(input: { vaultId: string; displayLabel: string }): Promise<Started> {
    if (this.busy) throw new Error('A connection attempt is already running');
    this.busy = true;
    try {
      const key = await this.keyStore(input.vaultId);
      const authorized = parseAuthorize(await this.api.authorize({
        vaultId: input.vaultId,
        hostPublicJwk: key.publicJwk,
        displayLabel: input.displayLabel,
      }));
      const signature = await signProof(key.privateKey, deviceGrantProofBytes({
        grantId: authorized.grantId, vaultId: input.vaultId,
        challenge: authorized.challenge,
      }));
      const presented = await this.api.present({
        deviceCode: authorized.deviceCode, signature,
      }) as { status?: unknown } | null;
      if (!presented || presented.status !== 'pending') {
        throw new Error('The vault key was not accepted');
      }
      return {
        deviceCode: authorized.deviceCode, userCode: authorized.userCode,
        verificationUrl: authorized.verificationUrl, expiresAtMs: authorized.expiresAtMs,
        intervalSeconds: authorized.intervalSeconds,
      };
    } finally { this.busy = false; }
  }

  /** One poll. The caller decides how often to call it; nothing here retries on its own. */
  async poll(deviceCode: string): Promise<Polled> {
    return parsePoll(await this.api.token({ deviceCode }));
  }

  /**
   * Polls until the grant resolves or the offer expires.
   *
   * A single awaited loop rather than a timer per tick: the caller can await it inside a modal,
   * and there is no interval to leak if the pane closes.
   */
  /**
   * Polls until the owner approves, the grant lapses, or the person closes the dialog.
   *
   * A 429 on a poll is not the end of the wait: the Worker tells the client how long to hold off, and
   * dying there turned a normal wait into "too many connection attempts". The budget that produced
   * that is now separate from grant creation, and this honours whatever wait is sent either way.
   */
  async wait(started: Started): Promise<Polled> {
    while (this.now() < started.expiresAtMs) {
      try {
        const answer = await this.poll(started.deviceCode);
        if (answer.state !== 'pending') return answer;
      } catch (error) {
        const refusal = error as { status?: number; retryAfterSeconds?: number };
        if (refusal?.status !== 429) throw error;
        const holdMs = Math.min((refusal.retryAfterSeconds ?? 60) * 1_000, 120_000);
        await wait(holdMs);
        continue;
      }
      await wait(started.intervalSeconds * 1_000);
    }
    return { state: 'expired' };
  }
}

/** Exported for the settings pane's validator: the Worker's user code shape, not a local guess. */
export function isUserCode(value: string): boolean {
  return userCodeValue.test(value);
}

export function isSignatureShape(value: string): boolean {
  return signatureValue.test(value);
}

export function decodeChallenge(challenge: string): Uint8Array {
  return unb64url(challenge);
}

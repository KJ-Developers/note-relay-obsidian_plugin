import {
  hostPairingKeyId, signHostPairingConfirmation, signHostPairingProof,
} from './pairing-key';
import { getOrCreateHostKey } from './pairing-key-store';
import type { StoredHostKey } from './pairing-key-store';
import { hasControlCharacter } from './characters';

type Lookup = {
  accountId: string; pairingId: string; challenge: string;
  accountEmail: string; expiresAt: string;
};
type Review = {
  accountEmail: string; pairingId: string; hostKeyId: string;
  vaultLabel: string; expiresAtMs: number;
};
type PairingApi = {
  lookup(code: string): Promise<unknown>;
  present(input: {
    code: string; vaultId: string; hostPublicJwk: StoredHostKey['publicJwk'];
    signature: string; displayLabel: string;
    deviceId?: string; machineLabel?: string;
  }): Promise<{ ok: boolean; status: number }>;
  confirm(input: { pairingId: string; signature: string }): Promise<boolean>;
};

/** This machine, as the plugin reports it. Optional: a build without app storage sends nothing. */
export type PairingDevice = { deviceId: string; machineLabel: string | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Z2-7]{5}-[A-Z2-7]{5}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;

function parseLookup(value: unknown): Lookup & { expiresAtMs: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid pairing response');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !==
      'accountEmail,accountId,challenge,expiresAt,pairingId' ||
      typeof row.accountId !== 'string' || !uuid.test(row.accountId) ||
      typeof row.pairingId !== 'string' || !uuid.test(row.pairingId) ||
      typeof row.challenge !== 'string' || !challengePattern.test(row.challenge) ||
      typeof row.accountEmail !== 'string' || row.accountEmail.length < 3 ||
      row.accountEmail.length > 254 || hasControlCharacter(row.accountEmail) ||
      typeof row.expiresAt !== 'string') throw new Error('Invalid pairing response');
  const expiresAtMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() ||
      expiresAtMs > Date.now() + 5 * 60_000 + 5_000) {
    throw new Error('Pairing code expired');
  }
  return { accountId: row.accountId, pairingId: row.pairingId,
    challenge: row.challenge, accountEmail: row.accountEmail,
    expiresAt: row.expiresAt, expiresAtMs };
}

export class PairingFlow {
  private pending: {
    lookup: Lookup & { expiresAtMs: number }; key: StoredHostKey;
    vaultId: string; review: Review;
  } | null = null;
  private busy = false;
  private generation = 0;

  constructor(private api: PairingApi,
    private keyStore: (vaultId: string) => Promise<StoredHostKey> = getOrCreateHostKey) {}

  cancel(): void { this.generation++; this.pending = null; }

  /**
   * Presents this vault, with the machine identity when we have one.
   *
   * The two device fields are additive, and a Worker that predates them rejects the body for having
   * keys it does not expect (400). That is not a pairing failure — it is an older server — so the
   * call is repeated without them rather than showing the owner a refusal for a compatible request.
   * Anything else is reported as it came.
   */
  private async present(
    code: string, vaultId: string, key: StoredHostKey, signature: string,
    vaultLabel: string, device: PairingDevice | null,
  ): Promise<{ ok: boolean; status: number }> {
    const base = { code, vaultId, hostPublicJwk: key.publicJwk, signature, displayLabel: vaultLabel };
    if (!device) return this.api.present(base);
    const withDevice = await this.api.present({ ...base,
      deviceId: device.deviceId,
      ...(device.machineLabel ? { machineLabel: device.machineLabel } : {}) });
    if (withDevice.ok || withDevice.status !== 400) return withDevice;
    return this.api.present(base);
  }

  async review(code: string, vaultId: string, vaultLabel: string,
    device: PairingDevice | null = null): Promise<Review> {
    if (this.busy) throw new Error('Pairing in progress');
    if (!codePattern.test(code) || !uuid.test(vaultId) ||
        vaultLabel.length < 1 || vaultLabel.length > 80 ||
        vaultLabel.trim() !== vaultLabel || hasControlCharacter(vaultLabel)) {
      throw new Error('Invalid pairing request');
    }
    this.busy = true;
    const generation = ++this.generation;
    this.pending = null;
    try {
      const lookup = parseLookup(await this.api.lookup(code));
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      const key = await this.keyStore(vaultId);
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      const context = { accountId: lookup.accountId,
        pairingId: lookup.pairingId, vaultId, challenge: lookup.challenge };
      const signature = await signHostPairingProof(key.privateKey, context);
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      const presented = await this.present(code, vaultId, key, signature, vaultLabel, device);
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      if (!presented.ok) throw new Error('Pairing unavailable');
      const hostKeyId = await hostPairingKeyId(key.publicJwk);
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      const review = { accountEmail: lookup.accountEmail,
        pairingId: lookup.pairingId, hostKeyId, vaultLabel,
        expiresAtMs: lookup.expiresAtMs };
      this.pending = { lookup, key, vaultId, review };
      return review;
    } finally { this.busy = false; }
  }

  async confirm(): Promise<boolean> {
    if (this.busy) throw new Error('Pairing in progress');
    const pending = this.pending;
    if (!pending || Date.now() >= pending.lookup.expiresAtMs) {
      this.pending = null;
      throw new Error('Pairing unavailable');
    }
    this.busy = true;
    const generation = this.generation;
    try {
      const signature = await signHostPairingConfirmation(pending.key.privateKey, {
        accountId: pending.lookup.accountId,
        pairingId: pending.lookup.pairingId,
        vaultId: pending.vaultId, challenge: pending.lookup.challenge,
      });
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      const confirmed = await this.api.confirm({
        pairingId: pending.lookup.pairingId, signature,
      });
      if (this.generation !== generation) throw new Error('Pairing cancelled');
      if (confirmed) this.pending = null;
      return confirmed;
    } finally { this.busy = false; }
  }
}

import { requestUrl } from 'obsidian';
import type { StoredHostKey } from './pairing-key-store';
import type { AuthorizationLease } from './authenticated-read-session';
import { signPresence, type PresenceProof } from './host-presence-proof';
import { WORKER_ORIGIN } from './endpoints';
import { clearTimer, setTimer } from './timers';

// The paired key signs presence. This endpoint never receives vault content.
const ORIGIN = WORKER_ORIGIN;
type Reply = { expiresAtMs?: unknown; entitlementRevision?: unknown; stopped?: unknown };
type Send = (proof: PresenceProof) => Promise<{ status: number; body: Reply }>;

export async function sendPresence(proof: PresenceProof): Promise<{ status: number; body: Reply }> {
  const response = await requestUrl({
    url: `${ORIGIN}/v1/host/presence`, method: 'POST',
    contentType: 'application/json', body: JSON.stringify(proof), throw: false,
  });
  if (response.text.length > 1024) throw new Error('Presence response too large');
  let body: Reply;
  try { body = JSON.parse(response.text) as Reply; }
  catch { throw new Error('Presence unavailable'); }
  return { status: response.status, body };
}

// A failed renewal never extends the local authorization lease. A stop waits
// for a pending renewal so that a delayed response cannot restore presence.
export class HostPresenceClient {
  private active = false;
  private timer: unknown = null;
  private current: Promise<void> = Promise.resolve();
  private lastIssuedAtMs = 0;
  private authorization: AuthorizationLease | null = null;
  private failure: ((reason: string) => void) | null;
  private onLease: ((lease: AuthorizationLease) => void) | null;

  constructor(private vaultId: string, private sessionId: string,
    private key: StoredHostKey, private send: Send = sendPresence,
    private now: () => number = Date.now,
    onFailure: ((reason: string) => void) | null = null,
    onLease: ((lease: AuthorizationLease) => void) | null = null) {
    this.failure = onFailure; this.onLease = onLease;
  }

  lease(): AuthorizationLease | null {
    return this.active && this.authorization && this.authorization.expiresAtMs > this.now()
      ? this.authorization : null;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.current = this.renew();
  }

  private issuedAt(): number {
    this.lastIssuedAtMs = Math.max(this.now(), this.lastIssuedAtMs + 1);
    return this.lastIssuedAtMs;
  }

  private async renew(): Promise<void> {
    if (!this.active) return;
    try {
      const proof = await signPresence('renew', this.vaultId,
        this.sessionId, this.key.privateKey, this.issuedAt());
      if (!this.active) return;
      const result = await this.send(proof);
      if (!this.active) return;
      if (result.status === 200 &&
          Number.isSafeInteger(result.body.expiresAtMs) &&
          Number.isSafeInteger(result.body.entitlementRevision) &&
          (result.body.expiresAtMs as number) > this.now() &&
          (result.body.expiresAtMs as number) <= this.now() + 60_000 + 5_000 &&
          (result.body.entitlementRevision as number) >= 0) {
        this.authorization = { expiresAtMs: result.body.expiresAtMs as number,
          entitlementRevision: result.body.entitlementRevision as number };
        this.onLease?.(this.authorization);
      }
      if (result.status === 404 || result.status === 403) {
        this.failure?.('Remote hosting is unavailable or this vault is disconnected.');
        return;
      }
    } catch { /* The previous short lease expires without a successful renewal. */ }
    // 60 s against a 150 s lease. The old 25 s was 25,344 Durable Object requests a month for a host
    // that is online all day — the single largest metered cost in the product, spent proving liveness
    // nobody was waiting for. Three missed renewals are now tolerated instead of two.
    if (this.active) this.timer = setTimer(() => { this.current = this.renew(); }, 60_000);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.authorization = null;
    if (this.timer) clearTimer(this.timer);
    await this.current.catch(() => {});
    try {
      const proof = await signPresence('stop', this.vaultId,
        this.sessionId, this.key.privateKey, this.issuedAt());
      await this.send(proof);
    } catch { /* The server lease still expires within 60 seconds. */ }
  }
}

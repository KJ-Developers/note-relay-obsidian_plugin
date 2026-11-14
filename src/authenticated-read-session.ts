import type { WritableChannel } from './framed-channel';
import { sendBinaryReply, sendFramedReply } from './framed-channel';
import { HostLifecycle } from './host-lifecycle';
import { acceptClientProof, newHostChallenge, verifyPeerGrant,
  type ExpectedGrant, type PeerGrant } from './peer-grant';
import { dispatchVaultRequest, type AccessScope, type Reply, type VaultAdapter } from './protocol';

export type AuthorizationLease = {
  expiresAtMs: number;
  entitlementRevision: number;
};

export class AuthenticatedReadSession {
  private proven = false;
  private closed = false;
  private readonly currentHost: () => boolean;
  private readonly hostSignal: AbortSignal;
  private readonly challengeBytes = newHostChallenge();

  private constructor(
    private readonly host: HostLifecycle,
    private readonly adapter: VaultAdapter,
    private readonly grant: PeerGrant,
    private readonly usedGrantIds: Set<string>,
    private readonly lease: () => AuthorizationLease | null,
  ) {
    this.currentHost = host.currentRequest();
    this.hostSignal = host.currentSignal();
  }

  static async create(
    host: HostLifecycle, adapter: VaultAdapter, token: string,
    keys: ReadonlyMap<string, CryptoKey>, expected: Omit<ExpectedGrant, 'hostSessionId'>,
    usedGrantIds: Set<string>, lease: () => AuthorizationLease | null,
    nowMs = Date.now(),
  ): Promise<AuthenticatedReadSession> {
    if (!host.enabled || !host.sessionId) throw new Error('Host offline');
    const hostSessionId = host.sessionId;
    const grant = await verifyPeerGrant(token, keys, { ...expected, hostSessionId }, nowMs);
    if (!host.enabled || host.sessionId !== hostSessionId) throw new Error('Host restarted');
    return new AuthenticatedReadSession(host, adapter, grant, usedGrantIds, lease);
  }

  challenge(): Uint8Array {
    if (this.closed || !this.currentHost()) throw new Error('Host offline');
    return Uint8Array.from(this.challengeBytes);
  }

  async prove(signature: string, nowMs = Date.now()): Promise<void> {
    if (this.closed || this.proven || !this.currentHost()) throw new Error('Session unavailable');
    await acceptClientProof(this.grant, this.challengeBytes, signature, this.usedGrantIds, nowMs);
    if (!this.currentHost()) throw new Error('Host stopped');
    this.proven = true;
  }

  close(): void { this.closed = true; }

  private authorized(nowMs = Date.now()): boolean {
    if (this.closed || !this.proven || !this.currentHost()) return false;
    const lease = this.lease();
    return !!lease && Number.isSafeInteger(lease.expiresAtMs) && nowMs < lease.expiresAtMs &&
      lease.entitlementRevision === this.grant.entitlementRevision;
  }

  /** The scope the grant was minted with. A read grant can never widen itself here. */
  scope(): AccessScope { return this.grant.scope; }

  async request(input: unknown): Promise<Reply> {
    if (!this.authorized()) throw new Error('Peer not authorized');
    const reply = await dispatchVaultRequest(this.adapter,
      { enabled: () => this.authorized(), scope: this.grant.scope }, input);
    if (!this.authorized()) throw new Error('Peer no longer authorized');
    return reply;
  }

  async send(channel: WritableChannel, input: unknown): Promise<void> {
    const reply = await this.request(input);
    // A request that speaks version 2 or later understands a compressed reply; anything older gets the
    // bytes it expects. The version is the capability signal, so no extra handshake is carried.
    const version = (input as { version?: unknown } | null)?.version;
    const compress = typeof version === 'number' && version >= 2;
    // Version 3 clients can read binary frames, so an image does not pay base64's 33%.
    if (typeof version === 'number' && version >= 3) {
      const bytes = rasterBytes(reply);
      if (bytes) {
        await sendBinaryReply(channel, reply, bytes, () => this.authorized(), this.currentHost,
          this.hostSignal);
        return;
      }
    }
    await sendFramedReply(channel, reply, () => this.authorized(), this.currentHost,
      this.hostSignal, compress);
  }
}


/** The bytes of a raster reply, or null when this reply is text. */
function rasterBytes(reply: Reply): Uint8Array | null {
  if (!reply.ok) return null;
  const data = (reply as { data?: { base64?: unknown; mime?: unknown } }).data;
  if (!data || typeof data.base64 !== 'string' || typeof data.mime !== 'string') return null;
  try {
    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

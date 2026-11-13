import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostSignalClient } from '../src/host-signal-client';
import { HostLifecycle } from '../src/host-lifecycle';
import { READER_WAIT_GRACE_MS, ReaderWaitMonitor } from '../src/host-waiting';
import { generateHostPairingKey } from '../src/pairing-key';
import type { StoredHostKey } from '../src/pairing-key-store';
import type { VaultAdapter } from '../src/protocol';

const VAULT_ID = 'b1a0f81c-208b-4ecf-b49e-9bb95aa94382';
const OFFER_SDP = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

/** The browser's WebSocket, reduced to what the client uses, with control over every edge. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string, readonly protocol?: string) { FakeSocket.instances.push(this); }

  send(data: string): void { this.sent.push(data); }

  /** A browser close always reports why; the empty reason is the default here for brevity. */
  close(code?: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    void code;
    this.onclose?.({ reason });
  }

  open(): void { this.readyState = 1; this.onopen?.(); }

  deliver(frame: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

/** Enough of a peer connection for the host's answer path; no ICE and no data channel. */
class FakePeer {
  static instances: FakePeer[] = [];
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  remoteDescription: unknown = null;
  localDescription: unknown = null;

  constructor(readonly configuration: unknown) { FakePeer.instances.push(this); }

  async setRemoteDescription(description: unknown): Promise<void> { this.remoteDescription = description; }
  async setLocalDescription(description: unknown): Promise<void> { this.localDescription = description; }
  async addIceCandidate(): Promise<void> {}
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
  }
  close(): void {}
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.run(); }
      }
    },
  };
}

const adapter: VaultAdapter = {
  listMarkdown: () => [], listFolders: () => [], tags: () => [], backlinks: () => [], outgoing: () => [],
  getFile: path => ({ path, extension: 'md' }),
  read: async () => '', readBinary: async () => new ArrayBuffer(0),
  preview: async () => ({ html: '', state: 'complete', renderer: 'test' }),
  searchNotes: async () => ({ matches: [], scanned: 0, total: 0, truncated: false }),
  properties: () => [],
  appearance: () => ({ mode: 'light', tokens: {} }),
};

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Drives the real client against a fake transport.
 *
 * `connect()` signs a real host proof and then builds a socket, so the first frame this reaches is
 * the frame the Worker would have built from: a host that only ever hears what the room forwards.
 */
async function connect() {
  FakeSocket.instances = [];
  FakePeer.instances = [];
  const clock = fakeClock();
  const changes: boolean[] = [];
  const wait = new ReaderWaitMonitor({
    onChange: waiting => changes.push(waiting),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const generated = await generateHostPairingKey();
  const key: StoredHostKey = { vaultId: VAULT_ID, privateKey: generated.privateKey, publicJwk: generated.publicJwk };
  const host = new HostLifecycle();
  host.start();
  const client = new HostSignalClient(VAULT_ID, host.sessionId!, key, host, adapter,
    () => ({ expiresAtMs: Date.now() + 600_000, entitlementRevision: 0 }), wait);
  client.start();
  await until(() => FakeSocket.instances.length === 1, 'the signalling socket');
  const socket = FakeSocket.instances[0];
  socket.open();
  return { client, socket, wait, changes, clock, host };
}

test('the socket authenticates as the host before any wait state is possible', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, socket } = await connect();
  const auth = JSON.parse(socket.sent[0]) as { type: string; role: string; proof: { vaultId: string } };
  assert.equal(auth.type, 'auth');
  assert.equal(auth.role, 'host');
  assert.equal(auth.proof.vaultId, VAULT_ID);
  client.stop();
});

test('an authenticated host that hears nothing reports nothing', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, wait, changes, clock } = await connect();
  clock.advance(READER_WAIT_GRACE_MS * 60);
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, []);
  client.stop();
});

test('a ready frame with no completed handshake raises the wait, and the socket closing clears it', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, socket, wait, changes, clock } = await connect();
  socket.deliver({ type: 'ready' });
  clock.advance(READER_WAIT_GRACE_MS);
  assert.equal(wait.isWaiting, true);
  assert.deepEqual(changes, [true]);
  socket.close(1001, 'Host disconnected');
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, [true, false]);
  client.stop();
});

test('peer-left clears a waiting reader before the reader is forgotten', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, socket, wait, clock } = await connect();
  socket.deliver({ type: 'ready' });
  clock.advance(READER_WAIT_GRACE_MS);
  assert.equal(wait.isWaiting, true);
  socket.deliver({ type: 'peer-left' });
  assert.equal(wait.isWaiting, false);
  client.stop();
});

test('an offer counts as a reader arriving, and the host still answers it', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, socket, wait, changes, clock } = await connect();
  socket.deliver({ type: 'offer', data: OFFER_SDP });
  await until(() => socket.sent.some(frame => (JSON.parse(frame) as { type: string }).type === 'answer'),
    'the answer');
  assert.equal(FakePeer.instances.length, 1, 'the offer must still be answered');
  clock.advance(READER_WAIT_GRACE_MS);
  assert.equal(wait.isWaiting, true);
  assert.deepEqual(changes, [true]);
  client.stop();
  assert.equal(wait.isWaiting, false, 'turning hosting off must clear the notice');
});

test('a malformed frame never raises the wait, because the room cannot have sent it', async t => {
  const restore = installFakes();
  t.after(restore);
  const { client, socket, wait, clock } = await connect();
  socket.onmessage?.({ data: 'not json' });
  socket.onmessage?.({ data: JSON.stringify({ type: 'ready', data: 'x'.repeat(64 * 1024) }) });
  clock.advance(READER_WAIT_GRACE_MS * 2);
  assert.equal(wait.isWaiting, false);
  client.stop();
});

function installFakes(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const priorSocket = globals.WebSocket;
  const priorPeer = globals.RTCPeerConnection;
  globals.WebSocket = FakeSocket;
  globals.RTCPeerConnection = FakePeer;
  return () => {
    globals.WebSocket = priorSocket;
    globals.RTCPeerConnection = priorPeer;
  };
}

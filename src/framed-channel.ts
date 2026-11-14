import { frameReply } from './framing';
import type { Reply } from './protocol';
import { clearTimer, setTimer } from './timers';

export const MAX_BUFFERED_BYTES = 256 * 1024;
export const SEND_WAIT_MS = 10_000;

export interface WritableChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer): void;
  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void;
  removeEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void;
}

function waitForSpace(channel: WritableChannel, signal: AbortSignal): Promise<void> {
  if (channel.bufferedAmount <= MAX_BUFFERED_BYTES / 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      clearTimer(timeout);
    };
    const onLow = () => { if (channel.bufferedAmount <= MAX_BUFFERED_BYTES / 2) { clean(); resolve(); } };
    const onAbort = () => { clean(); reject(new Error('Host stopped')); };
    const onClose = () => { clean(); reject(new Error('Peer closed')); };
    const timeout = setTimer(() => { clean(); reject(new Error('Peer stalled')); }, SEND_WAIT_MS);
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2;
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (channel.readyState !== 'open') onClose();
    else onLow();
  });
}

// Call only after the peer's grant and proof have been verified. The callbacks
// are checked for every frame because a lease or host generation can expire
// while a large reply waits behind a slow receiver.
export async function sendFramedReply(
  channel: WritableChannel, reply: Reply, allowed: () => boolean,
  current: () => boolean, signal: AbortSignal, compress = true,
): Promise<void> {
  const frames = await frameReply(reply, compress);
  for (const frame of frames) {
    if (signal.aborted || !current() || !allowed() || channel.readyState !== 'open') throw new Error('Peer no longer authorized');
    await waitForSpace(channel, signal);
    if (signal.aborted || !current() || !allowed() || channel.readyState !== 'open') throw new Error('Peer no longer authorized');
    channel.send(JSON.stringify(frame));
  }
}


/**
 * A reply whose bulk is bytes rather than text: a short JSON header, then the payload untouched.
 *
 * Base64 costs 33% on every image that crosses the channel, and an image is already compressed, so
 * there is nothing left for gzip to win back. The header travels as text so the client knows what it is
 * assembling; the rest is binary frames, which the data channel carries natively.
 */
export async function sendBinaryReply(
  channel: WritableChannel, reply: Reply, bytes: Uint8Array,
  allowed: () => boolean, current: () => boolean, signal: AbortSignal,
): Promise<void> {
  const meta = { ...(reply as { id: string; ok: boolean; data?: Record<string, unknown> }) };
  if (meta.data) {
    const { base64: _dropped, ...rest } = meta.data;
    meta.data = rest;
  }
  const chunks = Math.max(1, Math.ceil(bytes.length / BINARY_FRAME_BYTES));
  const header = JSON.stringify({ id: reply.id, index: 0, total: 1, z: 'raw', chunks,
    payload: JSON.stringify(meta) });
  await sendChunk(channel, header, allowed, current, signal);
  for (let offset = 0; offset < bytes.length; offset += BINARY_FRAME_BYTES) {
    if (!allowed() || !current()) throw new Error('Peer no longer authorized');
    if (signal.aborted) throw new Error('Host stopped');
    await waitForSpace(channel, signal);
    channel.send(bytes.slice(offset, offset + BINARY_FRAME_BYTES).buffer);
  }
}

/** Binary frame size: large enough to keep the frame count sane, small enough to stay under the buffer cap. */
const BINARY_FRAME_BYTES = 16 * 1024;

async function sendChunk(channel: WritableChannel, text: string,
  allowed: () => boolean, current: () => boolean, signal: AbortSignal): Promise<void> {
  if (!allowed() || !current()) throw new Error('Peer no longer authorized');
  if (signal.aborted) throw new Error('Host stopped');
  await waitForSpace(channel, signal);
  channel.send(text);
}

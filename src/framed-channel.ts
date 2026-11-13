import { frameReply } from './framing';
import type { Reply } from './protocol';

export const MAX_BUFFERED_BYTES = 256 * 1024;
export const SEND_WAIT_MS = 10_000;

export interface WritableChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string): void;
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
      clearTimeout(timeout);
    };
    const onLow = () => { if (channel.bufferedAmount <= MAX_BUFFERED_BYTES / 2) { clean(); resolve(); } };
    const onAbort = () => { clean(); reject(new Error('Host stopped')); };
    const onClose = () => { clean(); reject(new Error('Peer closed')); };
    const timeout = setTimeout(() => { clean(); reject(new Error('Peer stalled')); }, SEND_WAIT_MS);
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
  current: () => boolean, signal: AbortSignal,
): Promise<void> {
  const frames = frameReply(reply);
  for (const frame of frames) {
    if (signal.aborted || !current() || !allowed() || channel.readyState !== 'open') throw new Error('Peer no longer authorized');
    await waitForSpace(channel, signal);
    if (signal.aborted || !current() || !allowed() || channel.readyState !== 'open') throw new Error('Peer no longer authorized');
    channel.send(JSON.stringify(frame));
  }
}

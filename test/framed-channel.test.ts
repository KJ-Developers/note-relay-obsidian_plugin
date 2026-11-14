import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendFramedReply, MAX_BUFFERED_BYTES, type WritableChannel } from '../src/framed-channel';
import { HostLifecycle } from '../src/host-lifecycle';
import { ReplyAssembler, type ReplyFrame } from '../src/framing';

class FakeChannel implements WritableChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  listeners = new Set<() => void>();
  closeListeners = new Set<() => void>();
  send(data: string): void { this.sent.push(data); this.bufferedAmount += data.length; }
  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void {
    (type === 'close' ? this.closeListeners : this.listeners).add(listener);
  }
  removeEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void {
    (type === 'close' ? this.closeListeners : this.listeners).delete(listener);
  }
  drain(): void { this.bufferedAmount = 0; for (const listener of this.listeners) listener(); }
  close(): void { this.readyState = 'closed'; for (const listener of this.closeListeners) listener(); }
}

test('authorized framed sender assembles a large reply', async () => {
  const host = new HostLifecycle(); host.start();
  const channel = new FakeChannel();
  const reply = { ok: true as const, id: 'large', data: { source: 'a'.repeat(100_000) } };
  await sendFramedReply(channel, reply, () => true, host.currentRequest(), host.currentSignal());
  const assembler = new ReplyAssembler();
  let result = null;
  for (const packet of channel.sent) result = await assembler.add(JSON.parse(packet) as ReplyFrame);
  assert.deepEqual(result, reply);
  host.stop();
});

test('slow peer waits for buffer space and stop aborts before further frames', async () => {
  const host = new HostLifecycle(); host.start();
  const channel = new FakeChannel(); channel.bufferedAmount = MAX_BUFFERED_BYTES;
  const send = sendFramedReply(channel, { ok: true, id: 'x', data: 'a'.repeat(50_000) },
    () => true, host.currentRequest(), host.currentSignal());
  assert.equal(channel.sent.length, 0);
  host.stop();
  await assert.rejects(send, /Host stopped|no longer authorized/);
  channel.drain();
  assert.equal(channel.sent.length, 0);
});

test('lease expiry prevents later frames', async () => {
  const host = new HostLifecycle(); host.start();
  const channel = new FakeChannel(); channel.bufferedAmount = MAX_BUFFERED_BYTES;
  let allowed = true;
  const send = sendFramedReply(channel, { ok: true, id: 'lease', data: 'a'.repeat(50_000) },
    () => allowed, host.currentRequest(), host.currentSignal());
  allowed = false;
  channel.drain();
  await assert.rejects(send, /no longer authorized/);
  assert.equal(channel.sent.length, 0);
  host.stop();
});

test('closed peer cancels a stalled send and releases listeners', async () => {
  const host = new HostLifecycle(); host.start();
  const channel = new FakeChannel(); channel.bufferedAmount = MAX_BUFFERED_BYTES;
  const send = sendFramedReply(channel, { ok: true, id: 'closed', data: 'a'.repeat(50_000) },
    () => true, host.currentRequest(), host.currentSignal());
  channel.close();
  await assert.rejects(send, /Peer closed|no longer authorized/);
  assert.equal(channel.sent.length, 0);
  assert.equal(channel.listeners.size, 0);
  assert.equal(channel.closeListeners.size, 0);
  host.stop();
});

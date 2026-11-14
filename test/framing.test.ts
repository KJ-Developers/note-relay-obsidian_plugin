import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameReply, ReplyAssembler, FRAME_CHARS, MAX_REPLY_BYTES, type ReplyFrame } from '../src/framing';

/** Deterministic and incompressible: repeated text gzips to one frame and hides frame-count behaviour. */
function noise(length: number): string {
  let state = 0x9e3779b9;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    bytes[index] = 33 + (state % 90);
  }
  return new TextDecoder().decode(bytes);
}

test('large reply frames reassemble exactly in order', async () => {
  // Incompressible on purpose: repeated characters gzip to a single frame, and the point here is
  // reassembly across many frames.
  const reply = { ok: true as const, id: 'req-1', data: { source: noise(200_000) } };
  const frames = await frameReply(reply);
  assert.ok(frames.length > 1);
  assert.ok(frames.every(frame => frame.payload.length <= FRAME_CHARS));
  const assembler = new ReplyAssembler();
  let result = null;
  for (const frame of frames) result = await assembler.add(frame);
  assert.deepEqual(result, reply);
});

test('reply framing rejects overflow, gaps, replay, mixed IDs and expiry', async () => {
  await assert.rejects(() => frameReply({ ok: true, id: 'x', data: 'a'.repeat(MAX_REPLY_BYTES) }), /too large/);
  const frames = await frameReply({ ok: true, id: 'x', data: noise(FRAME_CHARS * 3) });
  const bad = async (change: (frames: ReplyFrame[]) => ReplyFrame[]) => {
    const assembler = new ReplyAssembler();
    const altered = change(frames.map(frame => ({ ...frame })));
    await assembler.add(altered[0], 0);
    await assert.rejects(() => assembler.add(altered[1], 1));
  };
  await bad(copy => [copy[0], copy[2]]);
  await bad(copy => [copy[0], copy[0]]);
  await bad(copy => { copy[1].id = 'other'; return copy; });
  const assembler = new ReplyAssembler();
  await assembler.add(frames[0], 0);
  await assert.rejects(() => assembler.add(frames[1], 10_001), /sequence/);
});

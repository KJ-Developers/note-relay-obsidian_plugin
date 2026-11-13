import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameReply, ReplyAssembler, FRAME_CHARS, MAX_REPLY_BYTES, type ReplyFrame } from '../src/framing';

test('large reply frames reassemble exactly in order', () => {
  const reply = { ok: true as const, id: 'req-1', data: { source: '🔐'.repeat(100_000) } };
  const frames = frameReply(reply);
  assert.ok(frames.length > 1);
  assert.ok(frames.every(frame => frame.payload.length <= FRAME_CHARS));
  const assembler = new ReplyAssembler();
  let result = null;
  for (const frame of frames) result = assembler.add(frame);
  assert.deepEqual(result, reply);
});

test('reply framing rejects overflow, gaps, replay, mixed IDs and expiry', () => {
  assert.throws(() => frameReply({ ok: true, id: 'x', data: 'a'.repeat(MAX_REPLY_BYTES) }), /too large/);
  const frames = frameReply({ ok: true, id: 'x', data: 'a'.repeat(FRAME_CHARS * 2) });
  const bad = (change: (frames: ReplyFrame[]) => ReplyFrame[]) => {
    const assembler = new ReplyAssembler();
    const altered = change(frames.map(frame => ({ ...frame })));
    assembler.add(altered[0], 0);
    assert.throws(() => assembler.add(altered[1], 1));
  };
  bad(copy => [copy[0], copy[2]]);
  bad(copy => [copy[0], copy[0]]);
  bad(copy => { copy[1].id = 'other'; return copy; });
  const assembler = new ReplyAssembler();
  assembler.add(frames[0], 0);
  assert.throws(() => assembler.add(frames[1], 10_001), /sequence/);
});

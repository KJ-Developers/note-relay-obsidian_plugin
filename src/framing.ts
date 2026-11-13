import type { Reply } from './protocol';

export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
export const FRAME_CHARS = 16 * 1024;
export const MAX_FRAMES = 128;
export const ASSEMBLY_TIMEOUT_MS = 10_000;

export type ReplyFrame = { id: string; index: number; total: number; payload: string };

export function frameReply(reply: Reply): ReplyFrame[] {
  const serialized = JSON.stringify(reply);
  if (new TextEncoder().encode(serialized).length > MAX_REPLY_BYTES) throw new Error('Reply too large');
  const total = Math.ceil(serialized.length / FRAME_CHARS);
  if (total < 1 || total > MAX_FRAMES) throw new Error('Too many frames');
  return Array.from({ length: total }, (_, index) => ({
    id: reply.id, index, total, payload: serialized.slice(index * FRAME_CHARS, (index + 1) * FRAME_CHARS),
  }));
}

export class ReplyAssembler {
  private parts: string[] = [];
  private id: string | null = null;
  private total = 0;
  private length = 0;
  private started = 0;

  reset(): void {
    this.parts = [];
    this.id = null;
    this.total = 0;
    this.length = 0;
    this.started = 0;
  }

  add(frame: ReplyFrame, now = Date.now()): Reply | null {
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(frame.id) || !Number.isInteger(frame.index) ||
      !Number.isInteger(frame.total) || frame.total < 1 || frame.total > MAX_FRAMES ||
      frame.index < 0 || frame.index >= frame.total || typeof frame.payload !== 'string' ||
      frame.payload.length > FRAME_CHARS) { this.reset(); throw new Error('Invalid reply frame'); }
    if (this.id === null) {
      if (frame.index !== 0) throw new Error('Missing first frame');
      this.id = frame.id;
      this.total = frame.total;
      this.started = now;
    }
    if (now - this.started > ASSEMBLY_TIMEOUT_MS || this.id !== frame.id || this.total !== frame.total ||
      frame.index !== this.parts.length) { this.reset(); throw new Error('Reply sequence failed'); }
    this.length += new TextEncoder().encode(frame.payload).length;
    if (this.length > MAX_REPLY_BYTES) { this.reset(); throw new Error('Reply too large'); }
    this.parts.push(frame.payload);
    if (this.parts.length !== this.total) return null;
    const raw = this.parts.join('');
    this.reset();
    let reply: unknown;
    try { reply = JSON.parse(raw); } catch { throw new Error('Invalid reply JSON'); }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
      (reply as Reply).id !== frame.id || typeof (reply as Reply).ok !== 'boolean') throw new Error('Invalid reply');
    return reply as Reply;
  }
}

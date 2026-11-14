import type { Reply } from './protocol';

export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
export const FRAME_CHARS = 16 * 1024;
export const MAX_FRAMES = 128;
export const ASSEMBLY_TIMEOUT_MS = 10_000;

export type ReplyFrame = { id: string; index: number; total: number; payload: string; z?: 'gzip' };

/**
 * Replies travel gzipped when that is smaller.
 *
 * HTML previews and tree pages are highly repetitive, so a Dataview page that costs 40 KB of JSON costs
 * about 7 KB inside a gzip stream. The frame envelope stays JSON text with a `z` marker, so there is one
 * code path and one place to read the bytes; base64 costs its 33%, which gzip's 5–8x covers easily.
 */
export async function frameReply(reply: Reply): Promise<ReplyFrame[]> {
  const serialized = JSON.stringify(reply);
  const raw = new TextEncoder().encode(serialized);
  if (raw.length > MAX_REPLY_BYTES) throw new Error('Reply too large');
  let body = serialized;
  let compressed = false;
  if (raw.length > COMPRESS_ABOVE_BYTES) {
    const packed = await gzipBase64(serialized);
    if (packed !== null && packed.length < serialized.length) { body = packed; compressed = true; }
  }
  const total = Math.ceil(body.length / FRAME_CHARS);
  if (total < 1 || total > MAX_FRAMES) throw new Error('Too many frames');
  return Array.from({ length: total }, (_, index) => ({
    id: reply.id, index, total, ...(compressed ? { z: 'gzip' as const } : {}),
    payload: body.slice(index * FRAME_CHARS, (index + 1) * FRAME_CHARS),
  }));
}

/** Below this, the gzip header and base64 cost more than they save. */
const COMPRESS_ABOVE_BYTES = 4 * 1024;

async function gzipBase64(value: string): Promise<string | null> {
  try {
    if (typeof CompressionStream !== 'function') return null;
    const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    // Chunked, because String.fromCharCode(...bytes) overflows the argument limit on large payloads.
    for (let index = 0; index < buffer.length; index += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  } catch { return null; }
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

  async add(frame: ReplyFrame, now = Date.now()): Promise<Reply | null> {
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string' ||
      (frame.z !== undefined && frame.z !== 'gzip') ||
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
    let raw = this.parts.join('');
    const compressed = frame.z === 'gzip';
    this.reset();
    if (compressed) {
      const restored = await gunzipBase64(raw);
      if (restored === null) throw new Error('Invalid compressed reply');
      raw = restored;
    }
    let reply: unknown;
    try { reply = JSON.parse(raw); } catch { throw new Error('Invalid reply JSON'); }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
      (reply as Reply).id !== frame.id || typeof (reply as Reply).ok !== 'boolean') throw new Error('Invalid reply');
    return reply as Reply;
  }
}

async function gunzipBase64(value: string): Promise<string | null> {
  try {
    if (typeof DecompressionStream !== 'function') return null;
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  } catch { return null; }
}

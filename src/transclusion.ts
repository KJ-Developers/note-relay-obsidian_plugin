// Transclusion: `![[Note]]` and `![[Note#Heading]]`.
//
// Expanding an embed means reading another note, so it happens on the host, before Markdown parses —
// the same rule as maths, and for the same reason: the browser never holds the vault.
//
// The interesting part is not the happy path. An embed can point at a note that embeds the original,
// and a naive expander hangs or blows up the response. So the expansion is bounded four ways:
// a stack (cycles), a depth cap, a per-embed budget and a total budget. Anything that exceeds a bound
// becomes visible text naming the note rather than a silent truncation — someone looking at a note
// should be able to tell why part of it is missing.

/** How deep embeds may nest. Obsidian feels unlimited; three is already unusual in real notes. */
export const MAX_EMBED_DEPTH = 3;
/** Embeds per note, so one note cannot request the whole vault. */
export const MAX_EMBEDS = 20;
/** Bytes of embedded note text, across all embeds in one render. */
export const MAX_EMBED_BYTES = 256 * 1024;
/** Bytes of a single embedded note; larger notes are named instead of included. */
export const MAX_EMBED_NOTE_BYTES = 64 * 1024;

export type EmbedResolver = (target: string) => Promise<string | null>;

export type EmbedResult = {
  /** The source with embeds replaced by their content and a marker. */
  source: string;
  /** Notes that were actually embedded, in order, for the caller to attribute. */
  embedded: string[];
  /** Notes named because they could not be embedded, and why. */
  skipped: Array<{ target: string; reason: 'missing' | 'cycle' | 'too_deep' | 'too_large' | 'too_many' }>;
  /** Bytes still available, so a caller can expand a sibling embed from the same allowance. */
  remainingBudget: number;
  /** Embeds counted so far, shared with nested expansions for the same reason. */
  count: number;
};

/**
 * `![[target]]` on its own line, or mid-sentence.
 *
 * The target may carry a `#Heading` fragment, which selects one section; a `^block` fragment is not
 * supported and is reported as skipped rather than quietly rendering the whole note, because showing
 * more of a note than the author asked for is the wrong failure.
 */
const EMBED = /!\[\[([^\]\r\n|]{1,512})\]\]/g;

/** Private-use markers around an embedded note, replaced with a wrapper after rendering. */
export const EMBED_START = '\uE002';
export const EMBED_END = '\uE003';

/** Splits an embed target into the note path and an optional `#Heading`. */
export function splitEmbedTarget(raw: string): { target: string; heading: string | null; block: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const hash = trimmed.indexOf('#');
  const target = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
  if (target.length === 0 || target.length > 512) return null;
  if (/[%\\:\u0000-\u001f\u007f]/u.test(target) || target.startsWith('/') || target.includes('//')) return null;
  if (!target.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))) return null;
  if (hash === -1) return { target, heading: null, block: false };
  const fragment = trimmed.slice(hash + 1).trim();
  if (fragment.length === 0) return { target, heading: null, block: false };
  // `^block-id` is a different feature and is not implemented; say so rather than showing everything.
  if (fragment.startsWith('^')) return { target, heading: null, block: true };
  return { target, heading: fragment, block: false };
}

/**
 * Extracts one heading's section from a note body.
 *
 * A section runs from its heading to the next heading of the same or shallower depth, which is what
 * Obsidian does. A note without that heading yields null, so the embed reads as missing rather than
 * as the whole note.
 */
export function sectionOf(source: string, heading: string): string | null {
  const lines = source.split('\n');
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (!match) continue;
    if (start === -1) {
      if (match[2].trim().toLowerCase() === wanted) { start = index; depth = match[1].length; }
      continue;
    }
    // The section ends at the next heading at the same level or above it.
    if (match[1].length <= depth) return lines.slice(start, index).join('\n').trimEnd();
  }
  if (start === -1) return null;
  return lines.slice(start).join('\n').trimEnd();
}

/** Strips a leading frontmatter block from an embedded note; its properties are not ours to inline. */
function withoutEmbeddedFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source;
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

/**
 * Expands every embed in `source`, honouring the bounds above.
 *
 * Embeds are wrapped in a marker paragraph so the caller can style them and so a reader can tell
 * where one note ends and the next begins. The marker survives Markdown because it is plain text.
 */
export async function expandTransclusions(source: string, resolve: EmbedResolver,
  options: { depth?: number; stack?: readonly string[]; originFile?: string;
    budget?: number; count?: number;
    /**
     * Targets that belong to another renderer and must be left exactly as written.
     *
     * An image embed (`![[picture.png]]`) is not a note, so expanding it here reported it as
     * "not found in this vault" — a statement about the user's vault that was simply false, shown in
     * place of their picture. The image path resolves it after Markdown has parsed.
     */
    leave?: (target: string) => boolean } = {}): Promise<EmbedResult> {
  const depth = options.depth ?? 0;
  const stack = options.stack ?? [];
  const embedded: string[] = [];
  const skipped: EmbedResult['skipped'] = [];
  // The budget and the embed count are shared with nested expansions, so a note that embeds twenty
  // notes which each embed twenty more cannot read four hundred notes on one render.
  let budget = options.budget ?? MAX_EMBED_BYTES;
  let count = options.count ?? 0;

  // Collect matches first so the replacement can be async.
  const matches = [...source.matchAll(EMBED)];
  if (matches.length === 0) return { source, embedded, skipped, remainingBudget: budget, count };

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index === undefined) continue;
    const parsed = splitEmbedTarget(match[1]);
    parts.push(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const note = (reason: EmbedResult['skipped'][number]['reason'], target = match[1].trim()) => {
      skipped.push({ target, reason });
      parts.push(`[embedded note unavailable: ${target} — ${REASON_TEXT[reason]}]`);
    };

    if (!parsed) { note('missing'); continue; }
    if (parsed.block) { skipped.push({ target: match[1].trim(), reason: 'missing' }); parts.push(
      `[embedded note unavailable: ${match[1].trim()} — block references are not supported]`); continue; }
    if (options.leave?.(parsed.target)) { parts.push(match[0]); continue; }
    // The count bounds *attempts*, not successes: a render may read at most MAX_EMBEDS notes for
    // transclusion in total, whichever level of nesting asks. Counting only successes would let a
    // fan-out read the vault while every embed was rejected for size.
    if (count >= MAX_EMBEDS) { note('too_many'); continue; }
    count += 1;
    if (budget <= 0) { note('too_large', parsed.target); continue; }
    if (depth >= MAX_EMBED_DEPTH) { note('too_deep', parsed.target); continue; }
    // A cycle is a repeat on the current path, not anywhere in the document: the same note embedded
    // twice as siblings is legitimate and appears twice in the vault too.
    if (stack.includes(parsed.target)) { note('cycle', parsed.target); continue; }

    const raw = await resolve(parsed.target);
    if (raw === null) { note('missing', parsed.target); continue; }
    const bytes = new TextEncoder().encode(raw).length;
    if (bytes > MAX_EMBED_NOTE_BYTES || bytes > budget) { note('too_large', parsed.target); continue; }

    const section = parsed.heading ? sectionOf(raw, parsed.heading) : withoutEmbeddedFrontmatter(raw);
    if (section === null) { note('missing', `${parsed.target}#${parsed.heading}`); continue; }

    budget -= bytes;
    embedded.push(parsed.target);

    // Nested embeds inside the included note are expanded with the path extended, so a cycle back to
    // any ancestor is caught here rather than recursing.
    const nested = await expandTransclusions(section, resolve, {
      depth: depth + 1, stack: [...stack, parsed.target], originFile: options.originFile,
      budget, count,
    });
    embedded.push(...nested.embedded);
    skipped.push(...nested.skipped);
    // Nested expansion spent from the same budget; keep the remainder for the next sibling embed.
    budget = nested.remainingBudget;
    count = nested.count;
    const label = match[1].trim();
    // Markers rather than a `<div>`: this renderer parses with `html: false`, so raw markup in the
    // source would be shown as text. The markers are plain characters and are turned into a wrapper
    // after rendering, by `wrapEmbeds`.
    parts.push(nested.source.trim().length === 0
      ? `\n[embedded note is empty: ${label}]\n`
      : `\n${EMBED_START}\n\n${nested.source}\n\n${EMBED_END}\n`);
  }
  parts.push(source.slice(cursor));
  return { source: parts.join(''), embedded, skipped, remainingBudget: budget, count };
}

const REASON_TEXT: Record<EmbedResult['skipped'][number]['reason'], string> = {
  missing: 'not found in this vault',
  cycle: 'it would embed itself',
  too_deep: 'nested too deeply',
  too_large: 'it is too large to embed',
  too_many: 'this note embeds too many others',
};

/**
 * Wraps each expanded embed in a container, after Markdown has rendered.
 *
 * The markers survive parsing as text, so this walks the rendered HTML: everything between a start and
 * an end marker moves into one `div.embed`. A marker with no partner is dropped rather than left in the
 * output, and nesting is handled by processing starts from the inside out.
 */
export function wrapEmbeds(html: string): string {
  if (!html.includes(EMBED_START) && !html.includes(EMBED_END)) return html;
  let working = html;
  // Handle the innermost pair first so nested embeds wrap correctly.
  for (let guard = 0; guard < MAX_EMBED_DEPTH + 2; guard += 1) {
    const start = working.lastIndexOf(EMBED_START);
    if (start === -1) break;
    const end = working.indexOf(EMBED_END, start);
    if (end === -1) break;
    const inner = working.slice(start + EMBED_START.length, end);
    working = working.slice(0, start) + `<div class="embed">${inner}</div>`
      + working.slice(end + EMBED_END.length);
  }
  // Any marker left without a partner is removed, so it can never reach a reader.
  return working.split(EMBED_START).join('').split(EMBED_END).join('');
}

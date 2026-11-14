import { safeAppearance } from './appearance';
import { MAX_SEARCH_RESULTS, MAX_SNIPPET_LENGTH, parseQuery } from './search';
import type { SearchReport } from './search';
import { hasControlCharacter, hasControlCharacterOtherThanLineWhitespace } from './characters';

export const PROTOCOL_VERSION = 2;
/**
 * Versions this build answers.
 *
 * 1 is the uncompressed framing; 2 is the same protocol with gzipped replies. Accepting both is what
 * lets an older browser work against this plugin, and it doubles as the capability signal: the reply is
 * only compressed when the request asked with a version that understands it.
 */
export const SUPPORTED_VERSIONS = new Set([1, 2]);
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_NOTE_BYTES = 1024 * 1024;
/**
 * Write requests carry a whole note body, so they need their own budget: the read request
 * cap (16 KiB) is sized for a path and a cursor, and would refuse to save any note larger
 * than that even though `READ_MARKDOWN` happily returns up to `MAX_NOTE_BYTES`. The value is
 * a WebRTC/SCTP single-message safe size (64 KiB), leaving room inside it for the JSON
 * envelope, so a note body is capped slightly below it.
 *
 * Known beta asymmetry: a note larger than `MAX_WRITE_NOTE_BYTES` can still be read but not
 * saved from the browser. Chunked upload is tracked as a follow-up rather than silently
 * raising this to 1 MiB, because one oversized frame is where SCTP starts to fragment badly.
 */
export const MAX_WRITE_REQUEST_BYTES = 64 * 1024;
export const MAX_WRITE_NOTE_BYTES = 60 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_RASTER_BYTES = 256 * 1024;
/** An original, for a download. Base64 of this must still fit inside MAX_REPLY_BYTES. */
export const FULL_RASTER_BYTES = 1400 * 1024;
export const TREE_PAGE_SIZE = 200;
export const TAG_PAGE_SIZE = 200;
/**
 * Tags kept per note.
 *
 * This used to be 32 and to *fail the whole snapshot* when one note had more: a single over-tagged
 * note in a real vault (an index note, a daily note with everything on it) removed tag browsing for
 * the entire vault, which is what a 15,000-note vault reported as "too many tags for the current
 * limit" on 2026-11-06. A note with more than this is truncated to its first 64 tags; the rest of the
 * vault is unaffected.
 */
export const MAX_TAGS_PER_FILE = 64;
/** Beyond this the snapshot is not a realistic vault; it is a signal to look, not a normal vault. */
export const MAX_TAG_ENTRIES = 60_000;
export const MAX_TAG_SNAPSHOT_BYTES = 12 * 1024 * 1024;
export const MAX_BACKLINKS = 500;
export const MAX_GRAPH_NEIGHBORS = 100;
export const MAX_TREE_ENTRIES = 20_000;
export const MAX_TREE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_TAG_INDEX = 20_000;
export const MAX_TREE_TAGS_PER_FILE = 20;
/** Paths per GET_PATHS page: 200 keeps a page near 13 KB, so the whole list is a handful of frames. */
export const PATHS_PAGE_SIZE = 200;
export const MAX_NOTES_WITH_TAG = 5_000;
export const MAX_PROPERTIES = 64;
export const MAX_PROPERTY_KEY = 128;
export const MAX_PROPERTY_VALUES = 32;
export const MAX_PROPERTY_VALUE = 512;
export const MAX_PROPERTIES_BYTES = 32 * 1024;

export type PropertyKind = 'text' | 'number' | 'boolean' | 'date' | 'list';
/** One frontmatter entry, already flattened to display strings by the host. */
export type PropertyEntry = { key: string; kind: PropertyKind; values: string[] };

export type ReadCommand = 'LIST_MARKDOWN' | 'LIST_VAULT_TREE' | 'LIST_VAULT_TREE_PAGE' | 'LIST_TAG_METADATA_PAGE' | 'GET_TAG_INDEX' | 'GET_NOTES_WITH_TAG' | 'GET_FOLDER_TREE' | 'GET_PATHS' | 'GET_BACKLINKS' | 'GET_LOCAL_GRAPH' | 'GET_PROPERTIES' | 'READ_MARKDOWN' | 'READ_RASTER' | 'RENDER_PREVIEW' | 'GET_APPEARANCE' | 'SEARCH_NOTES';

/** One row of the vault's own tag index, as Obsidian already keeps it. */
export type TagCount = { tag: string; count: number };
/**
 * Owner-write commands. They are deliberately a separate, closed set: adding one here is the
 * only way to widen what a paired browser can change, and every one of them requires an
 * `owner_write` grant. Until Base billing exists the Worker cannot mint that grant, so the
 * whole set is shipped but unreachable — dark, not disabled by a flag that could be flipped.
 */
export type WriteCommand = 'SAVE_NOTE' | 'CREATE_NOTE' | 'RENAME_NOTE' | 'MOVE_NOTE' | 'DELETE_NOTE';
export type Command = ReadCommand | WriteCommand;
export type FileRef = { path: string; extension: string };
export type Appearance = { mode: 'light' | 'dark'; tokens: Record<string, string> };
export type Preview = { html: string; state: 'complete' | 'incomplete'; renderer: string };

/** The scope a grant carries. Reads never need more than `read`. */
export type AccessScope = 'read' | 'owner_write' | 'write';

/**
 * Result of a write attempt, decided by the adapter inside its own atomic window.
 * `conflict` means the bytes on disk are not the bytes the caller last saw; `exists`
 * means the destination is already taken; `missing` means the source vanished.
 */
export type WriteOutcome = 'ok' | 'conflict' | 'exists' | 'missing';

export interface VaultAdapter {
  listMarkdown(): FileRef[];
  /**
   * Display-sized bytes for an image, or the original when `full` is asked for.
   *
   * Optional: an adapter without it still answers READ_RASTER from `readBinary`, just at full size,
   * which is what every host did before images were capped.
   */
  rasterForDisplay?(path: string, full: boolean): Promise<{ bytes: Uint8Array; mime: string; capped: boolean } | null>;
  listFolders(): string[];
  tags(file: FileRef): string[];
  /**
   * The vault's own tag index — `metadataCache.getTags()` — which Obsidian maintains continuously.
   * Optional: a host without it answers BAD_REQUEST and the browser falls back to the paged walk.
   */
  tagIndex?(): TagCount[];
  /** Every note carrying one tag, from the same index. Optional for the same reason. */
  notesWithTag?(tag: string): string[];
  /**
   * The folder skeleton: every folder and how many notes sit directly in it. One reply instead of a
   * request per folder, which is what made a deep tree reveal itself one click at a time.
   */
  folderTree?(): Array<{ path: string; count: number }>;
  /** Title (frontmatter, else filename) and modification time, for display and sorting. */
  fileMeta?(file: FileRef): { title?: string; mtime?: number };
  /** In-degree plus out-degree for a set of notes, in one pass over the link map. */
  linkCounts?(paths: string[]): Record<string, number>;
  backlinks(file: FileRef): string[];
  outgoing(file: FileRef): string[];
  getFile(path: string): FileRef | null;
  read(file: FileRef): Promise<string>;
  readBinary(file: FileRef): Promise<ArrayBuffer>;
  preview(file: FileRef, source: string): Promise<Preview>;
  properties(file: FileRef): PropertyEntry[];
  appearance(): Appearance;
  /**
   * Body-text search over the vault. Returns titles and short excerpts only; the note itself is
   * fetched separately when a result is opened.
   */
  searchNotes(query: string, limit: number): Promise<SearchReport>;
}

/**
 * The write surface, implemented only by an adapter that can actually change the vault.
 * Every method reports what happened rather than throwing, so the protocol layer owns the
 * mapping to reply codes and the adapter owns the atomicity.
 */
export interface WritableVaultAdapter extends VaultAdapter {
  /**
   * Overwrite `file` with `source` only if it still contains exactly `expected`.
   * The comparison happens inside the vault's own write window, so a change made in
   * Obsidian (or by sync) between the caller's read and this call cannot be clobbered.
   */
  writeNote(file: FileRef, source: string, expected: string): Promise<WriteOutcome>;
  createNote(path: string, source: string): Promise<WriteOutcome>;
  renameNote(file: FileRef, to: string): Promise<WriteOutcome>;
  /** Moves to Obsidian's trash rather than unlinking, so an owner can recover a mistake. */
  trashNote(file: FileRef, expected: string): Promise<WriteOutcome>;
}

export type Reply =
  | { ok: true; id: string; data: unknown }
  | { ok: false; id: string; error: 'OFFLINE' | 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'TOO_LARGE' | 'RENDER_FAILED' | 'STALE_CURSOR' | 'CONFLICT' | 'EXISTS' };

/** Host-side capability gate: is the host serving, and what may this peer change? */
export type Access = { enabled: boolean | (() => boolean); scope: AccessScope };

const readCommands = new Set<ReadCommand>(['LIST_MARKDOWN', 'LIST_VAULT_TREE', 'LIST_VAULT_TREE_PAGE', 'LIST_TAG_METADATA_PAGE', 'GET_TAG_INDEX', 'GET_NOTES_WITH_TAG', 'GET_FOLDER_TREE', 'GET_PATHS', 'GET_BACKLINKS', 'GET_LOCAL_GRAPH', 'GET_PROPERTIES', 'READ_MARKDOWN', 'READ_RASTER', 'RENDER_PREVIEW', 'GET_APPEARANCE', 'SEARCH_NOTES']);
const writeCommands = new Set<WriteCommand>(['SAVE_NOTE', 'CREATE_NOTE', 'RENAME_NOTE', 'MOVE_NOTE', 'DELETE_NOTE']);
const commands = new Set<Command>([...readCommands, ...writeCommands]);
const pathCommands = new Set<Command>(['GET_BACKLINKS', 'GET_LOCAL_GRAPH', 'GET_PROPERTIES', 'READ_MARKDOWN', 'READ_RASTER', 'RENDER_PREVIEW']);
/** Fields each command may carry. Anything else is refused, so no command can smuggle a parameter. */
const writeFields: Record<WriteCommand, string[]> = {
  SAVE_NOTE: ['version', 'id', 'cmd', 'path', 'source', 'hash'],
  CREATE_NOTE: ['version', 'id', 'cmd', 'path', 'source'],
  RENAME_NOTE: ['version', 'id', 'cmd', 'path', 'to'],
  MOVE_NOTE: ['version', 'id', 'cmd', 'path', 'to'],
  DELETE_NOTE: ['version', 'id', 'cmd', 'path', 'hash'],
};
const rasterTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function validMarkdownPath(path: unknown): path is string {
  return validVaultPath(path) && path.endsWith('.md');
}

export function validVaultPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 1 || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('%') || path.includes('//')) return false;
  if (hasControlCharacter(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function rasterMime(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return rasterTypes[extension] ?? null;
}

export function matchesRasterSignature(bytes: Uint8Array, mime: string): boolean {
  const at = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === 'image/png') return bytes.length >= 24 && at(137,80,78,71,13,10,26,10);
  if (mime === 'image/jpeg') return bytes.length >= 4 && at(255,216,255);
  if (mime === 'image/gif') return bytes.length >= 6 && at(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5] === 97;
  if (mime === 'image/webp') return bytes.length >= 12 && at(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return false;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function visibleMarkdownLinks(adapter: VaultAdapter, sources: string[]): string[] {
  return [...new Set(sources)].filter(source => {
    if (!validMarkdownPath(source)) return false;
    const found = adapter.getFile(source);
    return !!found && found.path === source && found.extension === 'md';
  }).sort();
}

function toBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
}

export async function dispatchReadOnly(adapter: VaultAdapter, enabled: boolean | (() => boolean), input: unknown): Promise<Reply> {
  return dispatchVaultRequest(adapter, { enabled, scope: 'read' }, input);
}

/** SHA-256 as lowercase hex. The protocol's content identity for conflict detection. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const CONTENT_HASH = /^[a-f0-9]{64}$/;

function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

const outcomeErrors = { conflict: 'CONFLICT', exists: 'EXISTS', missing: 'NOT_FOUND' } as const;

/**
 * Maps a non-success adapter outcome to a reply code. An unrecognised outcome is treated as
 * a failure rather than guessed at, so a future `WriteOutcome` cannot silently read as success.
 */
function outcomeReply(outcome: Exclude<WriteOutcome, 'ok'>, id: string): Reply {
  return { ok: false, id, error: outcomeErrors[outcome] ?? 'RENDER_FAILED' };
}

async function readCurrent(adapter: VaultAdapter, file: FileRef): Promise<string | null> {
  try { return await adapter.read(file); } catch { return null; }
}

/**
 * Executes one owner-write command. Callers have already established the grant scope, the
 * command's field set and the shape of `path`; everything here is about refuse-by-default:
 * canonical paths, byte caps, and a content hash that must still match the bytes on disk.
 */
async function applyWrite(
  adapter: WritableVaultAdapter, isEnabled: () => boolean, id: string, cmd: WriteCommand, obj: Record<string, unknown>,
): Promise<Reply> {
  const path = obj.path;
  if (!validMarkdownPath(path)) return { ok: false, id, error: 'FORBIDDEN' };
  const source = obj.source;
  const hash = obj.hash;
  const to = obj.to;

  if (cmd === 'SAVE_NOTE' || cmd === 'CREATE_NOTE') {
    if (typeof source !== 'string') return { ok: false, id, error: 'BAD_REQUEST' };
    if (byteLength(source) > MAX_WRITE_NOTE_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    if (hasControlCharacterOtherThanLineWhitespace(source)) return { ok: false, id, error: 'FORBIDDEN' };
  }
  if (cmd === 'SAVE_NOTE' || cmd === 'DELETE_NOTE') {
    if (typeof hash !== 'string' || !CONTENT_HASH.test(hash)) return { ok: false, id, error: 'BAD_REQUEST' };
  }
  if (cmd === 'RENAME_NOTE' || cmd === 'MOVE_NOTE') {
    if (!validMarkdownPath(to) || to === path) return { ok: false, id, error: 'FORBIDDEN' };
    // Keeping the two commands honest: rename changes the name in place, move changes the
    // folder. Otherwise a UI label can claim one thing while the host does the other.
    const sameFolder = folderOf(to) === folderOf(path);
    if (cmd === 'RENAME_NOTE' && !sameFolder) return { ok: false, id, error: 'FORBIDDEN' };
    if (cmd === 'MOVE_NOTE' && sameFolder) return { ok: false, id, error: 'FORBIDDEN' };
  }

  if (cmd === 'CREATE_NOTE') {
    const body = source as string;
    // Checked immediately before the mutation: writing after the host stopped would change
    // the vault for a peer that is no longer authorized.
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    let outcome: WriteOutcome;
    try { outcome = await adapter.createNote(path, body); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (outcome !== 'ok') return outcomeReply(outcome, id);
    return { ok: true, id, data: { path, hash: await sha256Hex(body) } };
  }

  const file = adapter.getFile(path);
  if (!file || file.path !== path || file.extension !== 'md') return { ok: false, id, error: 'NOT_FOUND' };

  if (cmd === 'RENAME_NOTE' || cmd === 'MOVE_NOTE') {
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    let outcome: WriteOutcome;
    try { outcome = await adapter.renameNote(file, to as string); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (outcome !== 'ok') return outcomeReply(outcome, id);
    return { ok: true, id, data: { path: to } };
  }

  // Both remaining commands are destructive-if-wrong, so both require the bytes to match.
  const current = await readCurrent(adapter, file);
  if (current === null) return { ok: false, id, error: 'NOT_FOUND' };
  if (await sha256Hex(current) !== hash) return { ok: false, id, error: 'CONFLICT' };
  if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };

  let outcome: WriteOutcome;
  try {
    outcome = cmd === 'DELETE_NOTE'
      ? await adapter.trashNote(file, current)
      : await adapter.writeNote(file, source as string, current);
  } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
  // No post-write OFFLINE: the vault already changed, so reporting OFFLINE would invite a
  // retry that then fails EXISTS/CONFLICT. The honest answer is what actually happened.
  if (outcome !== 'ok') return outcomeReply(outcome, id);
  if (cmd === 'DELETE_NOTE') return { ok: true, id, data: { path } };
  return { ok: true, id, data: { path, hash: await sha256Hex(source as string) } };
}

function isWritable(adapter: VaultAdapter): adapter is WritableVaultAdapter {
  const candidate = adapter as Partial<WritableVaultAdapter>;
  return typeof candidate.writeNote === 'function' && typeof candidate.createNote === 'function' &&
    typeof candidate.renameNote === 'function' && typeof candidate.trashNote === 'function';
}

/** The single entry point for both reads and writes. Writes additionally need `owner_write`. */
export async function dispatchVaultRequest(adapter: VaultAdapter, access: Access, input: unknown): Promise<Reply> {
  const gate = access.enabled;
  const isEnabled: () => boolean = typeof gate === 'function' ? gate : () => gate;
  if (!isEnabled()) return { ok: false, id: '', error: 'OFFLINE' };
  let raw: string;
  try { raw = JSON.stringify(input); } catch { return { ok: false, id: '', error: 'BAD_REQUEST' }; }
  // Two budgets: the larger one admits a note body, and the read cap is then re-applied
  // below once the command is known. Order matters — the command name lives inside `raw`.
  const size = raw ? byteLength(raw) : 0;
  if (!raw || size > MAX_WRITE_REQUEST_BYTES) return { ok: false, id: '', error: 'TOO_LARGE' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, id: '', error: 'BAD_REQUEST' };
  const obj = input as Record<string, unknown>;
  const id = typeof obj.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.id) ? obj.id : '';
  if (!id || typeof obj.version !== 'number' || !SUPPORTED_VERSIONS.has(obj.version) ||
      typeof obj.cmd !== 'string' || !commands.has(obj.cmd as Command)) {
    return { ok: false, id, error: 'BAD_REQUEST' };
  }
  const cmd = obj.cmd as Command;
  const isWrite = writeCommands.has(cmd as WriteCommand);
  const permitted = isWrite ? writeFields[cmd as WriteCommand] :
    cmd === 'SEARCH_NOTES' ? ['version', 'id', 'cmd', 'query', 'limit'] :
    // READ_RASTER alone takes `full`: the original bytes, for a download.
    cmd === 'READ_RASTER' ? ['version', 'id', 'cmd', 'path', 'full'] :
    pathCommands.has(cmd) ? ['version', 'id', 'cmd', 'path'] :
    // `path` on the tree page is the folder whose children are wanted: '' is the vault root.
    // Additive — an older browser sends no path and still gets the flat walk it expects.
    cmd === 'LIST_VAULT_TREE_PAGE' ? ['version', 'id', 'cmd', 'cursor', 'path'] :
    cmd === 'LIST_TAG_METADATA_PAGE' ? ['version', 'id', 'cmd', 'cursor'] :
    cmd === 'GET_NOTES_WITH_TAG' ? ['version', 'id', 'cmd', 'path'] :
    cmd === 'GET_PATHS' ? ['version', 'id', 'cmd', 'cursor'] : ['version', 'id', 'cmd'];
  if (Object.keys(obj).some(key => !permitted.includes(key))) return { ok: false, id, error: 'BAD_REQUEST' };
  if (pathCommands.has(cmd) && !(cmd === 'READ_RASTER' ? validVaultPath(obj.path) && !!rasterMime(obj.path) : validMarkdownPath(obj.path))) return { ok: false, id, error: 'FORBIDDEN' };
  // `path` is a folder on the tree page and a tag on GET_NOTES_WITH_TAG; it is a path everywhere else.
  if (!isWrite && !pathCommands.has(cmd) && cmd !== 'LIST_VAULT_TREE_PAGE' &&
      cmd !== 'GET_NOTES_WITH_TAG' && 'path' in obj) {
    // The id rides back even on a refusal: without it the browser cannot match the reply to its
    // request and waits for the ten-second timeout instead of failing at once.
    return { ok: false, id, error: 'BAD_REQUEST' };
  }
  if (cmd === 'SEARCH_NOTES') {
    if (typeof obj.query !== 'string' || parseQuery(obj.query) === null) return { ok: false, id, error: 'FORBIDDEN' };
    if (obj.limit !== undefined &&
        (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > MAX_SEARCH_RESULTS)) {
      return { ok: false, id, error: 'BAD_REQUEST' };
    }
  }

  // Writes are gated on the grant's scope *before* any vault work happens. A read grant can
  // never reach the adapter's write methods, whatever the host is otherwise willing to do.
  if (isWrite) {
    // Any scope that means "may change this vault" opens the write set. Refusing `write` here would make
    // the guest tier unreachable no matter what the Worker granted — the same shape of gate that made
    // owner_write dead in six places before it was noticed.
    if (access.scope !== 'owner_write' && access.scope !== 'write') {
      return { ok: false, id, error: 'FORBIDDEN' };
    }
    if (!isWritable(adapter)) return { ok: false, id, error: 'FORBIDDEN' };
    return applyWrite(adapter, isEnabled, id, cmd as WriteCommand, obj);
  }
  // Reads keep their original, tighter budget: nothing but paths, cursors and ids travel here.
  if (size > MAX_REQUEST_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
  if (cmd === 'LIST_VAULT_TREE_PAGE' && obj.path !== undefined && obj.path !== '' && !validVaultPath(obj.path)) {
    return { ok: false, id, error: 'FORBIDDEN' };
  }
  if ((cmd === 'LIST_VAULT_TREE_PAGE' || cmd === 'LIST_TAG_METADATA_PAGE') && obj.cursor !== undefined &&
    (typeof obj.cursor !== 'string' || !/^[a-f0-9]{32}:[1-9][0-9]{0,5}$/.test(obj.cursor))) {
    return { ok: false, id, error: 'BAD_REQUEST' };
  }

  if (cmd === 'GET_APPEARANCE') {
    try { return { ok: true, id, data: safeAppearance(adapter.appearance()) }; }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
  }
  if (cmd === 'SEARCH_NOTES') {
    let report: SearchReport;
    try { report = await adapter.searchNotes(obj.query as string, (obj.limit as number | undefined) ?? 50); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!report || !Array.isArray(report.matches)) return { ok: false, id, error: 'RENDER_FAILED' };
    // Each result carries a bounded excerpt, so the whole reply is bounded too.
    const data = {
      matches: report.matches.filter(match => validMarkdownPath(match.path)).map(match => ({
        path: match.path,
        hits: Math.max(1, Math.floor(match.hits)),
        snippet: String(match.snippet).slice(0, MAX_SNIPPET_LENGTH),
      })),
      scanned: Math.max(0, Math.floor(report.scanned)),
      total: Math.max(0, Math.floor(report.total)),
      truncated: report.truncated === true,
    };
    if (byteLength(JSON.stringify(data)) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data };
  }
  if (cmd === 'LIST_MARKDOWN') {
    let files: string[];
    try { files = adapter.listMarkdown().filter(file => validMarkdownPath(file.path)).map(file => file.path); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (files.length > 5000 || byteLength(JSON.stringify(files)) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data: { paths: files } };
  }
  if (cmd === 'LIST_VAULT_TREE') {
    let files: string[];
    let folders: string[];
    try {
      files = adapter.listMarkdown().filter(file => validMarkdownPath(file.path)).map(file => file.path).sort();
      folders = adapter.listFolders().filter(validVaultPath).sort();
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (files.length > 5000 || folders.length > 5000 || byteLength(JSON.stringify({ files, folders })) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data: { files, folders } };
  }
  if (cmd === 'GET_TAG_INDEX') {
    // Obsidian keeps a tag index of the whole vault in memory; reading it is a map copy, not a walk.
    // The per-note scan this replaces answers the same question after ninety round trips.
    if (!adapter.tagIndex) return { ok: false, id, error: 'BAD_REQUEST' };
    let tags: TagCount[];
    try { tags = adapter.tagIndex(); } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    const clean = tags
      .filter(entry => entry && typeof entry.tag === 'string' && entry.tag.length > 0 && entry.tag.length <= 128 &&
        typeof entry.count === 'number' && Number.isFinite(entry.count) && entry.count >= 0)
      .map(entry => ({ tag: entry.tag.replace(/^#/, ''), count: Math.floor(entry.count) }))
      .filter(entry => entry.tag.length > 0);
    if (clean.length > MAX_TAG_INDEX) return { ok: false, id, error: 'TOO_LARGE' };
    const data = { tags: clean, total: clean.length };
    if (byteLength(JSON.stringify(data)) > MAX_TAG_SNAPSHOT_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    return { ok: true, id, data };
  }

  if (cmd === 'GET_FOLDER_TREE') {
    if (!adapter.folderTree) return { ok: false, id, error: 'BAD_REQUEST' };
    let folders: Array<{ path: string; count: number }>;
    try {
      folders = adapter.folderTree()
        .filter(entry => entry && typeof entry.path === 'string' && (entry.path === '' || validVaultPath(entry.path)))
        .map(entry => ({ path: entry.path, count: Math.max(0, Math.floor(Number(entry.count) || 0)) }));
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (folders.length > MAX_TREE_ENTRIES) return { ok: false, id, error: 'TOO_LARGE' };
    const data = { folders, total: folders.length };
    if (byteLength(JSON.stringify(data)) > MAX_TREE_SNAPSHOT_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    return { ok: true, id, data };
  }

  if (cmd === 'GET_PATHS') {
    // Every note path in pages, so the quick switcher can search the whole vault rather than the
    // folders that happen to have been opened. The cursor is a digest of the listing, as on the tree:
    // a vault that changed between pages says so instead of silently shifting.
    let paths: string[];
    try { paths = adapter.listMarkdown().filter(file => validMarkdownPath(file.path)).map(file => file.path).sort(); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (paths.length > MAX_TREE_ENTRIES) return { ok: false, id, error: 'TOO_LARGE' };
    let digest: ArrayBuffer;
    try { digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(paths))); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    const revision = Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    const cursor = obj.cursor as string | undefined;
    if (cursor && !cursor.startsWith(`${revision}:`)) return { ok: false, id, error: 'STALE_CURSOR' };
    const offset = cursor ? Number(cursor.slice(33)) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor && offset >= paths.length)) {
      return { ok: false, id, error: 'BAD_REQUEST' };
    }
    const page = paths.slice(offset, offset + PATHS_PAGE_SIZE);
    const nextOffset = offset + page.length;
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    return { ok: true, id, data: { paths: page, total: paths.length,
      nextCursor: nextOffset < paths.length ? `${revision}:${nextOffset}` : null } };
  }

  if (cmd === 'GET_NOTES_WITH_TAG') {
    if (!adapter.notesWithTag) return { ok: false, id, error: 'BAD_REQUEST' };
    const tag = typeof obj.path === 'string' ? obj.path.replace(/^#/, '').trim() : '';
    if (!tag || tag.length > 128 || hasControlCharacter(tag)) return { ok: false, id, error: 'BAD_REQUEST' };
    // The adapter decides what "carries this tag" means — including nested tags beneath it — because
    // only it can see the vault's hierarchy. The protocol only bounds the answer.
    let paths: string[];
    try { paths = adapter.notesWithTag(tag).filter(path => validMarkdownPath(path)).sort(); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (paths.length > MAX_NOTES_WITH_TAG) return { ok: false, id, error: 'TOO_LARGE' };
    if (byteLength(JSON.stringify(paths)) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    return { ok: true, id, data: { tag, paths, total: paths.length } };
  }

  if (cmd === 'LIST_VAULT_TREE_PAGE') {
    let entries: { kind: 'file' | 'folder'; path: string }[];
    // A folder-scoped page is one folder's children: the browser expands a folder and asks for
    // what is under it, instead of walking the whole vault to reach it. On an 18,490-note vault the
    // flat walk is ~93 round trips and re-hashes the entire listing on every one of them.
    const folder = obj.path as string | undefined;
    const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    try {
      entries = [
        ...adapter.listMarkdown().filter(file => validMarkdownPath(file.path))
          .filter(file => folder === undefined || parentOf(file.path) === folder)
          .map(file => {
            // The tags ride along with the entry: the browser then knows a note's tags exactly when
            // it learns the note exists, instead of paging the whole vault again to find out.
            const own = adapter.tagIndex ? adapter.tags(file) : [];
            const tags = [...new Set(own.map(tag => tag.replace(/^#/, '').trim()).filter(Boolean))]
              .slice(0, MAX_TREE_TAGS_PER_FILE);
            // Title and modification time ride along so the browser can show a note's real name and
            // sort by when it changed, without a second request per note.
            const meta = adapter.fileMeta ? adapter.fileMeta(file) : {};
            const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim().slice(0, 200) : undefined;
            const mtime = typeof meta.mtime === 'number' && Number.isFinite(meta.mtime) ? Math.floor(meta.mtime) : undefined;
            const entry: { kind: 'file'; path: string; tags?: string[]; title?: string; mtime?: number } =
              { kind: 'file', path: file.path };
            if (tags.length) entry.tags = tags;
            if (title) entry.title = title;
            if (mtime) entry.mtime = mtime;
            return entry;
          }),
        ...adapter.listFolders().filter(validVaultPath)
          .filter(path => folder === undefined || parentOf(path) === folder)
          .map(path => ({ kind: 'folder' as const, path })),
      ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (entries.length > MAX_TREE_ENTRIES) return { ok: false, id, error: 'TOO_LARGE' };
    // A folder page answers with a digest of that folder's own entries, so its cursor is cheap to
    // build and still detects a vault that changed between pages.
    const encoded = new TextEncoder().encode(JSON.stringify(entries));
    if (encoded.byteLength > MAX_TREE_SNAPSHOT_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    let digest: ArrayBuffer;
    try { digest = await crypto.subtle.digest('SHA-256', encoded); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    const revision = Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    const cursor = obj.cursor as string | undefined;
    if (cursor && !cursor.startsWith(`${revision}:`)) return { ok: false, id, error: 'STALE_CURSOR' };
    const offset = cursor ? Number(cursor.slice(33)) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor && offset >= entries.length)) return { ok: false, id, error: 'BAD_REQUEST' };
    const page = entries.slice(offset, offset + TREE_PAGE_SIZE);
    const nextOffset = offset + page.length;
    return { ok: true, id, data: { entries: page, nextCursor: nextOffset < entries.length ? `${revision}:${nextOffset}` : null } };
  }

  if (cmd === 'LIST_TAG_METADATA_PAGE') {
    let entries: { path: string; tags: string[] }[];
    try {
      entries = adapter.listMarkdown().filter(file => validMarkdownPath(file.path)).map(file => {
        const rawTags = adapter.tags(file);
        // Truncate this note, never the vault: a note with hundreds of tags is a curiosity, and
        // refusing the whole snapshot over it is what made tag browsing unavailable.
        const all = [...new Set(rawTags
          .filter(tag => typeof tag === 'string')
          .map(tag => tag.replace(/^#/, '').trim())
          .filter(tag => tag && tag.length <= 128 && !hasControlCharacter(tag)))].sort();
        const tags = all.slice(0, MAX_TAGS_PER_FILE);
        // Not silent: a note carrying more tags than the page allows says so, with the real count,
        // so the browser can mark it rather than quietly showing partial membership.
        return all.length > tags.length
          ? { path: file.path, tags, tagCount: all.length }
          : { path: file.path, tags };
      }).filter(entry => entry.tags.length > 0).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (entries.length > MAX_TAG_ENTRIES) return { ok: false, id, error: 'TOO_LARGE' };
    const encoded = new TextEncoder().encode(JSON.stringify(entries));
    if (encoded.byteLength > MAX_TAG_SNAPSHOT_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    let digest: ArrayBuffer;
    try { digest = await crypto.subtle.digest('SHA-256', encoded); } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    const revision = Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
    const cursor = obj.cursor as string | undefined;
    if (cursor && !cursor.startsWith(`${revision}:`)) return { ok: false, id, error: 'STALE_CURSOR' };
    const offset = cursor ? Number(cursor.slice(33)) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor && offset >= entries.length)) return { ok: false, id, error: 'BAD_REQUEST' };
    const page = entries.slice(offset, offset + TAG_PAGE_SIZE);
    const nextOffset = offset + page.length;
    return { ok: true, id, data: { entries: page, nextCursor: nextOffset < entries.length ? `${revision}:${nextOffset}` : null } };
  }

  const path = obj.path as string;
  const file = adapter.getFile(path);
  if (!file || file.path !== path) return { ok: false, id, error: 'NOT_FOUND' };
  if (cmd === 'GET_BACKLINKS') {
    if (file.extension !== 'md') return { ok: false, id, error: 'NOT_FOUND' };
    let backlinks: string[];
    try {
      backlinks = visibleMarkdownLinks(adapter, adapter.backlinks(file));
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    if (backlinks.length > MAX_BACKLINKS || byteLength(JSON.stringify(backlinks)) > MAX_PREVIEW_BYTES) {
      return { ok: false, id, error: 'TOO_LARGE' };
    }
    return { ok: true, id, data: { path, backlinks } };
  }
  if (cmd === 'GET_PROPERTIES') {
    if (file.extension !== 'md') return { ok: false, id, error: 'NOT_FOUND' };
    let entries: PropertyEntry[];
    try {
      entries = adapter.properties(file);
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    if (!Array.isArray(entries) || entries.length > MAX_PROPERTIES) return { ok: false, id, error: 'TOO_LARGE' };
    // Re-validate every entry at the boundary: the adapter is trusted code, but the
    // browser must never receive a shape it cannot strictly check itself.
    const clean: PropertyEntry[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') return { ok: false, id, error: 'RENDER_FAILED' };
      const { key, kind, values } = entry;
      if (typeof key !== 'string' || key.length < 1 || key.length > MAX_PROPERTY_KEY) return { ok: false, id, error: 'TOO_LARGE' };
      if (!['text', 'number', 'boolean', 'date', 'list'].includes(kind)) return { ok: false, id, error: 'RENDER_FAILED' };
      if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PROPERTY_VALUES) return { ok: false, id, error: 'TOO_LARGE' };
      if (!values.every(value => typeof value === 'string' && value.length <= MAX_PROPERTY_VALUE)) return { ok: false, id, error: 'TOO_LARGE' };
      if (hasControlCharacterOtherThanLineWhitespace(key) || values.some(value =>
        hasControlCharacterOtherThanLineWhitespace(value))) return { ok: false, id, error: 'FORBIDDEN' };
      clean.push({ key, kind, values: [...values] });
    }
    if (byteLength(JSON.stringify(clean)) > MAX_PROPERTIES_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data: { path, properties: clean } };
  }
  if (cmd === 'GET_LOCAL_GRAPH') {
    if (file.extension !== 'md') return { ok: false, id, error: 'NOT_FOUND' };
    let incoming: string[];
    let outgoing: string[];
    try {
      incoming = visibleMarkdownLinks(adapter, adapter.backlinks(file)).filter(source => source !== path);
      outgoing = visibleMarkdownLinks(adapter, adapter.outgoing(file)).filter(target => target !== path);
    } catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    // A hub note — an index, a daily entry, a project map — has more than a hundred connections, and
    // refusing the graph there is a wrong answer at the one place it is most useful. Keep the most
    // connected hundred and say how many were left out.
    const degree = adapter.linkCounts ? adapter.linkCounts([path, ...incoming, ...outgoing]) : {};
    const neighbours = [...new Set([...incoming, ...outgoing])]
      .sort((a, b) => (degree[b] ?? 0) - (degree[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    const kept = neighbours.slice(0, MAX_GRAPH_NEIGHBORS);
    const keptSet = new Set(kept);
    const edges = [...incoming.map(source => ({ from: source, to: path })),
      ...outgoing.map(target => ({ from: path, to: target }))]
      .filter(edge => keptSet.has(edge.from === path ? edge.to : edge.from));
    const tags = adapter.tagIndex ? [...new Set(adapter.tags(file).map(tag => tag.replace(/^#/, '').trim())
      .filter(Boolean))].slice(0, MAX_TREE_TAGS_PER_FILE) : [];
    // Shape is additive: `nodes` stays a list of paths, so an older browser is unaffected.
    const data = { center: path, nodes: [path, ...kept], edges, degree,
      tags, omitted: Math.max(0, neighbours.length - kept.length) };
    if (byteLength(JSON.stringify(data)) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data };
  }
  if (cmd === 'READ_RASTER') {
    const mime = rasterMime(path);
    if (!mime || rasterMime(`x.${file.extension}`) !== mime) return { ok: false, id, error: 'FORBIDDEN' };
    // `full` asks for the file as it sits in the vault, which is what a download needs. Anything else
    // gets the display size: the reader cannot tell the difference at 900 px, and the original can be
    // several megabytes of somebody's phone camera.
    const full = obj.full === true;
    const limit = full ? FULL_RASTER_BYTES : MAX_RASTER_BYTES;
    if (adapter.rasterForDisplay) {
      const shown = await adapter.rasterForDisplay(path, full);
      if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
      if (!shown) return { ok: false, id, error: 'TOO_LARGE' };
      if (shown.bytes.length > limit) return { ok: false, id, error: 'TOO_LARGE' };
      if (!matchesRasterSignature(shown.bytes, shown.mime)) return { ok: false, id, error: 'FORBIDDEN' };
      return { ok: true, id, data: { path, mime: shown.mime, capped: shown.capped,
        base64: toBase64(shown.bytes) } };
    }
    let binary: ArrayBuffer;
    try { binary = await adapter.readBinary(file); } catch { return { ok: false, id, error: 'NOT_FOUND' }; }
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    if (!(binary instanceof ArrayBuffer) || binary.byteLength > limit) return { ok: false, id, error: 'TOO_LARGE' };
    const bytes = new Uint8Array(binary);
    if (!matchesRasterSignature(bytes, mime)) return { ok: false, id, error: 'FORBIDDEN' };
    return { ok: true, id, data: { path, mime, base64: toBase64(bytes) } };
  }
  if (file.extension !== 'md') return { ok: false, id, error: 'NOT_FOUND' };
  let source: string;
  try { source = await adapter.read(file); } catch { return { ok: false, id, error: 'NOT_FOUND' }; }
  if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
  if (byteLength(source) > MAX_NOTE_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
  if (cmd === 'READ_MARKDOWN') {
    // The host hashes the exact bytes it is returning. The browser therefore never computes the
    // hash of something it merely believes it received, and conflict detection has one
    // implementation rather than two that could disagree.
    let hash: string;
    try { hash = await sha256Hex(source); }
    catch { return { ok: false, id, error: 'RENDER_FAILED' }; }
    return { ok: true, id, data: { path, source, hash } };
  }
  try {
    const preview = await adapter.preview(file, source);
    if (!isEnabled()) return { ok: false, id, error: 'OFFLINE' };
    if (typeof preview?.html !== 'string' || (preview.state !== 'complete' && preview.state !== 'incomplete') ||
      typeof preview.renderer !== 'string' || !/^[a-z0-9-]{1,64}$/.test(preview.renderer)) {
      return { ok: false, id, error: 'RENDER_FAILED' };
    }
    if (byteLength(preview.html) > MAX_PREVIEW_BYTES) return { ok: false, id, error: 'TOO_LARGE' };
    return { ok: true, id, data: { path, html: preview.html, state: preview.state, renderer: preview.renderer } };
  } catch {
    return { ok: false, id, error: 'RENDER_FAILED' };
  }
}

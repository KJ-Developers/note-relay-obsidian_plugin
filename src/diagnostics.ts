/**
 * The diagnostics bundle a user can copy when something goes wrong.
 *
 * Every hard bug in this product is invisible to the person hitting it. A close code distinguishes a
 * vault held by another device from a rate limit from a lost network, an old plugin omits a content
 * hash and fails a save with a message that reads like a bug, a relayed connection behaves
 * differently from a direct one, and a partial vault load is silent. Each of those took an hour of
 * questions to establish; none of them is something a user can see.
 *
 * So the user copies this instead. Two rules make it usable:
 *
 * 1. **Plain labelled lines, not JSON.** The user reads it before pasting, and a support reader
 *    scans a column of labels far faster than a tree of braces.
 * 2. **Nothing about their notes.** No paths, no titles, no folders, no query text, no contents.
 *    The note count appears as a bucket, because "1k–10k" separates a cap problem from a small vault
 *    without publishing the size of someone's private vault.
 */

/** A close of the signalling socket, kept so a support reader can see why the host is not connected. */
export type HostCloseRecord = { code: number; reason: string; at: number };

export type DiagnosticsInput = {
  /** ISO timestamp of when the bundle was built. Passed in, never read from the clock here. */
  nowMs?: number;
  pluginVersion?: string;
  protocolVersion?: number;
  manifestVersion?: string;
  obsidianVersion?: string;
  platform?: string;
  hosting?: boolean;
  presence?: string;
  lastClose?: HostCloseRecord | null;
  transport?: 'direct' | 'relayed' | null;
  renegotiations?: number;
  noteCount?: number;
  tagCount?: number;
  view?: string;
  /** A Worker URL, if one is reported. Only the host is ever printed. */
  endpoint?: string;
};

const UNKNOWN = 'unknown';

/**
 * A note count as a range.
 *
 * Deliberately lossy: the exact number is a fact about someone's private vault, while the range is
 * the thing that decides whether a failure is a size problem. Boundaries are inclusive at the top,
 * so 100 notes is `1–100` and 101 is `100–1k`.
 */
export function noteCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count <= 100) return '1–100';
  if (count <= 1_000) return '100–1k';
  if (count <= 10_000) return '1k–10k';
  return '10k+';
}

/**
 * A hostname without its path or query.
 *
 * A Worker URL can carry a path that names a deployment or an account; a support reader needs the
 * host and nothing else. Anything unparseable is reported as unknown rather than echoed.
 */
export function endpointHost(value: string | undefined): string {
  if (!value) return UNKNOWN;
  try { return new URL(value).host } catch { return UNKNOWN; }
}

function age(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/**
 * The bundle.
 *
 * A missing fact prints `unknown` rather than dropping its line, so a reader can tell "not available"
 * from "fine". The one exception is a fact this build genuinely cannot obtain, which is left out
 * entirely instead of being guessed at — an invented value in a support bundle is worse than a gap.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const now = input.nowMs ?? 0;
  const lines: string[] = [];
  lines.push(`Note Relay diagnostics — ${new Date(now).toISOString()}`);

  const versions = [
    `plugin ${input.pluginVersion ?? UNKNOWN}`,
    `protocol ${input.protocolVersion ?? UNKNOWN}`,
  ];
  if (input.manifestVersion) versions.push(`manifest ${input.manifestVersion}`);
  lines.push(versions.join(' · '));

  lines.push(`obsidian ${input.obsidianVersion ?? UNKNOWN} · ${input.platform ?? UNKNOWN}`);
  lines.push(`hosting: ${input.hosting === undefined ? UNKNOWN : input.hosting ? 'on' : 'off'}`
    + ` · presence: ${input.presence ?? UNKNOWN}`);

  // The most valuable line here. Four codes, four different problems, and until now nothing
  // recorded any of them.
  if (input.lastClose === undefined) lines.push(`last close: ${UNKNOWN}`);
  else if (input.lastClose === null) lines.push('last close: none this session');
  else {
    const reason = input.lastClose.reason ? ` ${input.lastClose.reason}` : '';
    lines.push(`last close: ${input.lastClose.code}${reason} · ${age(input.lastClose.at, now)}`);
  }

  lines.push(`transport: ${input.transport ?? UNKNOWN}`
    + ` · renegotiations: ${input.renegotiations ?? UNKNOWN}`);
  lines.push(`vault: ${input.noteCount === undefined ? UNKNOWN : noteCountBucket(input.noteCount)} notes`
    + ` · tags: ${input.tagCount ?? UNKNOWN}`);
  lines.push(`view: ${input.view ?? UNKNOWN}`);
  if (input.endpoint) lines.push(`endpoint: ${endpointHost(input.endpoint)}`);
  lines.push('');
  lines.push('No note titles, paths, folder names, search text or file contents are included.');
  return lines.join('\n');
}

// Body-text search over the vault, decided here and executed on the host.
//
// The browser never holds the vault, so it cannot search it. The plugin does the searching and
// returns **titles** plus a short excerpt; the note body is only fetched when someone clicks a
// result. That keeps the result payload small and keeps note content on the wire only when a note is
// actually being read.
//
// The matcher is written here rather than taken from `prepareSimpleSearch` for two reasons: it must
// be testable in this repository without an Electron host, and its syntax has to be documented
// exactly so the hint shown to a user is true. It is a plain AND of terms with three extras:
//
//   `alpha beta`     both terms must appear (any order, any case)
//   `"exact phrase"` the quoted text must appear verbatim
//   `-draft`         the note must not contain `draft`
//
// Deliberately not regex: a user typing `*` or `(` should get no results, not an exception.

/** A query longer than this is a paste accident, not a search. */
export const MAX_QUERY_LENGTH = 200;
/** Results are bounded; the list is a way in, not an export of the vault. */
export const MAX_SEARCH_RESULTS = 200;
import { hasControlCharacter } from './characters';

/** Excerpt around the first match, so a title is not the only thing distinguishing two hits. */
export const MAX_SNIPPET_LENGTH = 160;

export type SearchTerm = { value: string; negated: boolean };

/** Parses a query into terms, or returns null when the query is unusable. */
export function parseQuery(query: string): SearchTerm[] | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUERY_LENGTH) return null;
  if (hasControlCharacter(trimmed)) return null;
  const terms: SearchTerm[] = [];
  const pattern = /(-?)"([^"]+)"|(-?)([^\s"]+)/g;
  for (const match of trimmed.matchAll(pattern)) {
    let negated = (match[1] ?? match[3]) === '-';
    let value = (match[2] ?? match[4] ?? '').trim();
    // The regex can leave a leading dash inside the value (a lone `-`, or `--term`), so resolve it
    // here rather than relying on which alternative matched.
    while (value.startsWith('-')) { negated = true; value = value.slice(1); }
    value = value.trim();
    // A bare dash or an empty quoted string is not a term; ignoring it beats refusing the query.
    if (value.length === 0) continue;
    terms.push({ value: value.toLowerCase(), negated });
  }
  return terms.length === 0 ? null : terms;
}

export type NoteMatch = { path: string; hits: number; snippet: string };

/**
 * Matches one note's text against parsed terms.
 *
 * Returns null when the note does not match, so a caller can filter without inspecting a shape.
 * `hits` counts occurrences of the first positive term, which is the number a person expects to see
 * beside a result: how many times the thing they typed appears.
 */
export function matchNote(path: string, text: string, terms: SearchTerm[]): NoteMatch | null {
  const haystack = text.toLowerCase();
  let hits = 0;
  let firstIndex = -1;
  let counted = false;
  for (const term of terms) {
    const index = haystack.indexOf(term.value);
    if (term.negated) {
      // A negation is satisfied by absence; its presence rules the note out.
      if (index !== -1) return null;
      continue;
    }
    if (index === -1) return null;
    if (!counted) {
      firstIndex = index;
      counted = true;
      let from = 0;
      while (true) {
        const at = haystack.indexOf(term.value, from);
        if (at === -1) break;
        hits += 1;
        from = at + term.value.length;
      }
    }
  }
  if (firstIndex === -1) firstIndex = 0;
  return { path, hits, snippet: excerpt(text, firstIndex) };
}

/** A single-line excerpt around `index`, with ellipses where it was cut. */
export function excerpt(text: string, index: number): string {
  if (MAX_SNIPPET_LENGTH <= 0) return '';
  // Frontmatter is not what someone searching a body is looking for; skip past it when present.
  const start = Math.max(0, index - Math.floor(MAX_SNIPPET_LENGTH / 3));
  let slice = text.slice(start, start + MAX_SNIPPET_LENGTH);
  slice = slice.replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + MAX_SNIPPET_LENGTH < text.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

/** Sorts results the way a search should: most hits first, then path for a stable order. */
export function rankMatches(matches: NoteMatch[], limit: number): NoteMatch[] {
  const bounded = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;
  return [...matches]
    .sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path))
    .slice(0, bounded);
}

export type SearchReport = {
  matches: NoteMatch[];
  /** Notes actually searched, and how many exist: the difference is what tells a user it was partial. */
  scanned: number;
  total: number;
  truncated: boolean;
};

/**
 * Bytes of note text a single search may read.
 *
 * Obsidian keeps note text in memory after its first read, so a warm vault scans at memory speed and
 * this budget is rarely reached. A cold vault — first search after launch — pays real disk I/O, and
 * a fixed budget keeps one search from stalling the editor for tens of seconds.
 */
export const MAX_SEARCH_BYTES = 24 * 1024 * 1024;

/** How many notes to read between yields, so the Obsidian UI stays responsive during a search. */
export const YIELD_EVERY = 200;

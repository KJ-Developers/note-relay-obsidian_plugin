import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_QUERY_LENGTH, MAX_SEARCH_RESULTS, MAX_SNIPPET_LENGTH, excerpt, matchNote,
  parseQuery, rankMatches } from '../src/search';

test('a query is an AND of terms, case-insensitive and order-free', () => {
  const terms = parseQuery('Alpha beta')!;
  assert.equal(terms.length, 2);
  assert.equal(matchNote('A.md', 'beta then ALPHA here', terms) !== null, true);
  assert.equal(matchNote('B.md', 'only alpha here', terms), null);
  assert.equal(matchNote('C.md', 'neither word', terms), null);
});

test('a quoted phrase must appear verbatim', () => {
  const terms = parseQuery('"exact phrase"')!;
  assert.equal(matchNote('A.md', 'an exact phrase appears', terms) !== null, true);
  // Both words present but not adjacent: quoted means contiguous.
  assert.equal(matchNote('B.md', 'exact and then phrase', terms), null);
});

test('a negated term rules a note out, and one with only negatives matches everything else', () => {
  const terms = parseQuery('project -draft')!;
  assert.equal(matchNote('A.md', 'project notes', terms) !== null, true);
  assert.equal(matchNote('B.md', 'project draft notes', terms), null);

  const onlyNegative = parseQuery('-draft')!;
  assert.equal(matchNote('C.md', 'clean text', onlyNegative) !== null, true);
  assert.equal(matchNote('D.md', 'a draft', onlyNegative), null);
});

test('an unusable query is refused rather than searched', () => {
  for (const query of ['', '   ', '\u0000term', 'x'.repeat(MAX_QUERY_LENGTH + 1), '-', '""']) {
    assert.equal(parseQuery(query), null, `expected ${JSON.stringify(query)} to be refused`);
  }
  // A bare `-` with a real term still works, because the stray dash is simply not a term.
  assert.equal(parseQuery('- alpha')!.length, 1);
});

test('regex-looking input is treated as literal text, not as a pattern', () => {
  const terms = parseQuery('a.*b')!;
  // If this were compiled as a regex, `a.*b` would match "axxb". As text it must not.
  assert.equal(matchNote('A.md', 'axxb', terms), null);
  assert.equal(matchNote('B.md', 'literal a.*b here', terms) !== null, true);
  assert.equal(parseQuery('(')!.length, 1);
});

test('hits counts occurrences of the term a user typed', () => {
  const match = matchNote('A.md', 'todo here, todo there, TODO again', parseQuery('todo')!)!;
  assert.equal(match.hits, 3);
});

test('an excerpt is one bounded line around the match', () => {
  const text = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`;
  const snippet = excerpt(text, 500);
  assert.ok(snippet.length <= MAX_SNIPPET_LENGTH + 2, `snippet was ${snippet.length} chars`);
  assert.match(snippet, /needle/);
  assert.equal(/\n/.test(snippet), false);
  assert.match(snippet, /^…/);
  assert.match(snippet, /…$/);
});

test('ranking puts the most hits first and is stable on ties', () => {
  const matches = [
    { path: 'b.md', hits: 1, snippet: '' },
    { path: 'a.md', hits: 3, snippet: '' },
    { path: 'c.md', hits: 1, snippet: '' },
  ];
  assert.deepEqual(rankMatches(matches, 10).map(m => m.path), ['a.md', 'b.md', 'c.md']);
});

test('results are bounded even when a caller asks for more', () => {
  const many = Array.from({ length: MAX_SEARCH_RESULTS + 50 }, (_, index) =>
    ({ path: `n${index}.md`, hits: 1, snippet: '' }));
  assert.equal(rankMatches(many, 10_000).length, MAX_SEARCH_RESULTS);
  assert.equal(rankMatches(many, 5).length, 5);
  // An absurd or malformed limit falls back to the maximum rather than returning nothing.
  assert.equal(rankMatches(many, 0).length, MAX_SEARCH_RESULTS);
  assert.equal(rankMatches(many, -3).length, MAX_SEARCH_RESULTS);
});

test('searching does not depend on the file extension or path shape', () => {
  const terms = parseQuery('needle')!;
  assert.equal(matchNote('deep/folder/Note.md', 'a needle', terms) !== null, true);
  assert.equal(matchNote('Shallow.md', 'a needle', terms) !== null, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMBED_END, EMBED_START, expandTransclusions, MAX_EMBEDS, MAX_EMBED_DEPTH, sectionOf,
  splitEmbedTarget, wrapEmbeds } from '../src/transclusion';

/** A resolver backed by a plain map, so each case reads as the vault it describes. */
const vault = (notes: Record<string, string>) => async (target: string) => notes[target] ?? null;

test('an embed is replaced by the other note body', async () => {
  const result = await expandTransclusions('Before\n\n![[Other]]\n\nAfter',
    vault({ Other: '# Other note\n\nits body\n' }));
  assert.match(result.source, /Before/);
  assert.match(result.source, /its body/);
  assert.match(result.source, /After/);
  assert.deepEqual(result.embedded, ['Other']);
  // The embed is marked so the renderer can box it after parsing; the wrapper is not raw markup,
  // because this renderer parses with html:false and would show it as text.
  assert.ok(result.source.includes(EMBED_START), 'expected a start marker');
  assert.ok(result.source.includes(EMBED_END), 'expected an end marker');
  assert.equal(/<div/.test(result.source), false);
});

test('a section embed includes only that heading, to the next heading of the same depth', async () => {
  const note = '# Top\n\ntop body\n\n## Part\n\npart body\n\n### Deeper\n\ndeeper body\n\n## Next\n\nnext body\n';
  const result = await expandTransclusions('![[Note#Part]]', vault({ Note: note }));
  assert.match(result.source, /part body/);
  assert.match(result.source, /deeper body/);
  assert.equal(/next body/.test(result.source), false);
  assert.equal(/top body/.test(result.source), false);
});

test('a missing heading names the note rather than showing the whole thing', async () => {
  // Showing everything would be showing more of a note than the author asked for.
  const result = await expandTransclusions('![[Note#Nowhere]]', vault({ Note: '# Real\n\nbody' }));
  assert.equal(/body/.test(result.source), false);
  assert.match(result.source, /unavailable: Note#Nowhere/);
  assert.equal(result.skipped[0].reason, 'missing');
});

test('an embed cycle becomes a visible note, not a hang', async () => {
  const result = await expandTransclusions('![[A]]', vault({
    A: '# A\n\n![[B]]\n', B: '# B\n\n![[A]]\n',
  }));
  assert.match(result.source, /A/);
  assert.match(result.source, /B/);
  // The second visit to A is refused by name.
  assert.ok(result.skipped.some(entry => entry.reason === 'cycle' && entry.target === 'A'),
    JSON.stringify(result.skipped));
  assert.match(result.source, /it would embed itself/);
});

test('a self-embed is refused immediately', async () => {
  const result = await expandTransclusions('![[Self]]', vault({ Self: '![[Self]]' }));
  assert.ok(result.skipped.some(entry => entry.reason === 'cycle'));
});

test('the same note embedded twice as siblings is allowed, because that is what the vault says', async () => {
  const result = await expandTransclusions('![[Same]]\n\n![[Same]]', vault({ Same: 'body' }));
  assert.equal((result.source.match(/body/g) ?? []).length, 2);
  assert.deepEqual(result.skipped, []);
});

test('nesting is capped, and the cap is reported', async () => {
  const chain: Record<string, string> = {};
  for (let index = 0; index < MAX_EMBED_DEPTH + 3; index += 1) {
    chain[`N${index}`] = `level ${index}\n\n![[N${index + 1}]]`;
  }
  const result = await expandTransclusions('![[N0]]', vault(chain));
  assert.match(result.source, /level 0/);
  assert.ok(result.skipped.some(entry => entry.reason === 'too_deep'), JSON.stringify(result.skipped));
});

test('a missing note is named rather than silently dropped', async () => {
  const result = await expandTransclusions('![[Ghost]]', vault({}));
  assert.match(result.source, /unavailable: Ghost — not found in this vault/);
  assert.equal(result.embedded.length, 0);
});

test('the number of embeds is bounded', async () => {
  const notes: Record<string, string> = {};
  for (let index = 0; index < MAX_EMBEDS + 5; index += 1) notes[`Note${index}`] = `body ${index}`;
  const source = Array.from({ length: MAX_EMBEDS + 5 }, (_, index) => `![[Note${index}]]`).join('\n\n');
  const result = await expandTransclusions(source, vault(notes));
  assert.equal(result.embedded.length, MAX_EMBEDS);
  assert.ok(result.skipped.some(entry => entry.reason === 'too_many'));
});

test('an oversized note is named, not truncated into something misleading', async () => {
  const result = await expandTransclusions('![[Huge]]', vault({ Huge: 'x'.repeat(70 * 1024) }));
  assert.equal(/xxxx/.test(result.source), false);
  assert.match(result.source, /too large to embed/);
});

test('frontmatter of an embedded note is not inlined', async () => {
  const result = await expandTransclusions('![[HasProps]]',
    vault({ HasProps: '---\ntitle: Secret title\n---\n\nreal body\n' }));
  assert.match(result.source, /real body/);
  assert.equal(/Secret title/.test(result.source), false);
});

test('a block reference is refused by name instead of embedding the whole note', async () => {
  const result = await expandTransclusions('![[Note#^abc123]]', vault({ Note: 'whole note body' }));
  assert.equal(/whole note body/.test(result.source), false);
  assert.match(result.source, /block references are not supported/);
});

test('a traversal target never reaches the resolver', async () => {
  let asked = 0;
  const counting = async () => { asked += 1; return 'should not happen'; };
  for (const bad of ['![[../secret]]', '![[/etc/passwd]]', '![[.obsidian/app]]', '![[a//b]]']) {
    await expandTransclusions(bad, counting);
  }
  assert.equal(asked, 0, 'an invalid target must not be resolved at all');
});

test('an embed target is split into note and heading, and rejects unsafe shapes', () => {
  assert.deepEqual(splitEmbedTarget('Note'), { target: 'Note', heading: null, block: false });
  assert.deepEqual(splitEmbedTarget('folder/Note#Part'), { target: 'folder/Note', heading: 'Part', block: false });
  assert.deepEqual(splitEmbedTarget('Note#^blk'), { target: 'Note', heading: null, block: true });
  for (const bad of ['', '../x', '/abs', 'a//b', 'perc%ent', 'back\\slash']) {
    assert.equal(splitEmbedTarget(bad), null, `expected ${bad} to be rejected`);
  }
});

test('a section lookup is case-insensitive and keeps the heading line', () => {
  const note = '# Intro\n\nintro\n\n## Part One\n\ncontent\n';
  const section = sectionOf(note, 'part one');
  assert.ok(section);
  assert.match(section, /## Part One/);
  assert.match(section, /content/);
  assert.equal(sectionOf(note, 'absent'), null);
});

test('text that only looks like an embed is left alone', async () => {
  const result = await expandTransclusions('a ![[link]] inside a sentence and ![[x', vault({ link: 'body' }));
  // Even mid-sentence it expands, because that is what Obsidian does.
  assert.match(result.source, /body/);
  // An unterminated one is untouched.
  assert.match(result.source, /!\[\[x/);
});

test('a fan-out of embeds cannot read the vault by spending one budget per level', async () => {
  // Each note embeds several others: with a per-call budget, depth would multiply the reads.
  const notes: Record<string, string> = {};
  const body = 'x'.repeat(60 * 1024);
  for (let level = 0; level < 3; level += 1) {
    for (let index = 0; index < 5; index += 1) {
      notes[`L${level}-${index}`] = `${body}\n\n![[L${level + 1}-0]]\n![[L${level + 1}-1]]\n![[L${level + 1}-2]]\n![[L${level + 1}-3]]\n![[L${level + 1}-4]]`;
    }
  }
  let reads = 0;
  const counted = async (target: string) => { reads += 1; return notes[target] ?? null; };
  const result = await expandTransclusions('![[L0-0]]', counted);
  // Attempts are bounded, so the reads are bounded whatever the nesting does; the byte budget then
  // bounds what actually comes back.
  assert.ok(reads <= MAX_EMBEDS, `at most ${MAX_EMBEDS} notes may be read, got ${reads}`);
  assert.ok(result.skipped.some(entry => entry.reason === 'too_large'));
});

test('the wrapper is applied to rendered HTML, and a stray marker never reaches a reader', () => {
  const rendered = `<p>before</p><p>${EMBED_START}</p><p>inside</p><p>${EMBED_END}</p><p>after</p>`;
  const wrapped = wrapEmbeds(rendered);
  assert.match(wrapped, /<div class="embed">/);
  assert.match(wrapped, /inside/);
  assert.equal(wrapped.includes(EMBED_START), false);
  assert.equal(wrapped.includes(EMBED_END), false);
  // Nothing is lost: the surrounding content is intact.
  assert.match(wrapped, /before/);
  assert.match(wrapped, /after/);
});

test('nested embeds wrap from the inside out', () => {
  const rendered = `<p>${EMBED_START}</p>outer<p>${EMBED_START}</p>inner<p>${EMBED_END}</p><p>${EMBED_END}</p>`;
  const wrapped = wrapEmbeds(rendered);
  assert.equal((wrapped.match(/<div class="embed">/g) ?? []).length, 2);
  assert.match(wrapped, /inner/);
  assert.match(wrapped, /outer/);
});

test('html with no markers is returned untouched', () => {
  const html = '<p>plain note</p>';
  assert.equal(wrapEmbeds(html), html);
});

test('an unpaired marker is removed rather than shown', () => {
  assert.equal(wrapEmbeds(`<p>a${EMBED_START}b</p>`), '<p>ab</p>');
  assert.equal(wrapEmbeds(`<p>a${EMBED_END}b</p>`), '<p>ab</p>');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
const { renderStaticPreview, sanitizePreview } = await import('../src/preview');

test('only exact DQL fences call Dataview; JS and raw HTML remain inert text', async () => {
  const calls: string[] = [];
  const source = '# Test\n<script>danger()</script>\n``` dataviewjs\ndanger()\n```\nValue:$=danger()\n```dataview\nTABLE status\n```';
  const html = await renderStaticPreview(source, 'Test.md', async (query, origin) => {
    calls.push(`${origin}:${query.trim()}`);
    return '| status |\n| --- |\n| active |';
  });
  assert.deepEqual(calls, ['Test.md:TABLE status']);
  assert.match(html, /&lt;script&gt;danger\(\)&lt;\/script&gt;/);
  assert.match(html, /dataviewjs/);
  assert.match(html, /\$=danger\(\)/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>/);
});

test('static parser strips active links, images, and HTML from source and query results', async () => {
  const source = '[send](https://evil.test/x) ![image](https://evil.test/i) <img src="https://evil.test/j">\n```dataview\nLIST\n```';
  const html = await renderStaticPreview(source, 'Test.md', async () => '- [x] Done <script>alert(1)</script> [remote](https://evil.test/z)');
  assert.match(html, /☑ Done/);
  const result = new JSDOM(html).window.document;
  assert.equal(result.querySelector('a, img, script, [href], [src]'), null);
});

test('Dataview wiki links display a static label without navigation', async () => {
  const html = await renderStaticPreview('```dataview\nLIST\n```', 'Test.md', async () => '- [[Folder/Source.md|Source]]');
  assert.match(html, /<li>Source<\/li>/);
  assert.doesNotMatch(html, /<a|href=/i);
});

test('reading preview hides frontmatter while preserving the visible note body', async () => {
  const html = await renderStaticPreview('---\ntags:\n  - interface/nested\n---\n# Visible note\nBody', 'Test.md', async () => '');
  assert.match(html, /<h1>Visible note<\/h1>/);
  assert.doesNotMatch(html, /interface\/nested|tags:|<hr>/);
});

test('query count and result size are bounded before output', async () => {
  const eleven = '```dataview\nLIST\n```\n'.repeat(11);
  let calls = 0;
  await assert.rejects(renderStaticPreview(eleven, 'Test.md', async () => { calls++; return '- a'; }), /limit/);
  assert.equal(calls, 0);
  await assert.rejects(renderStaticPreview('```dataview\nLIST\n```', 'Test.md', async () => 'a'.repeat(129 * 1024)), /too large/);
  await assert.rejects(renderStaticPreview('```dataview\nLIST\n```', 'Test.md', async () => undefined as unknown as string), /Invalid/);
});

test('last sanitizer removes unexpected active HTML and attributes', () => {
  const safe = sanitizePreview('<table onclick="alert(1)"><tr><td>Result</td></tr></table><img src="https://evil.test/x"><script>alert(1)</script>');
  assert.match(safe, /<table>/);
  assert.match(safe, /Result/);
  assert.doesNotMatch(safe, /<script|<img|onclick|https:\/\//i);
});

test('wiki links emit inert bounded note markers while labels and raw HTML stay escaped', async () => {
  const html = await renderStaticPreview('Open [[GUI-Tag-Fixture]] and [[Folder/Other.md|Other]]. <script>bad()</script>\n\n`[[Literal]]`',
    'GUI Backlink Source.md', async () => '');
  const doc = new JSDOM(html).window.document;
  const links = [...doc.querySelectorAll('a')];
  assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('data-note-target'), link.getAttribute('href')]),
    [['GUI-Tag-Fixture', 'GUI-Tag-Fixture', '#note'], ['Other', 'Folder/Other.md', '#note']]);
  assert.match(doc.querySelector('code')?.textContent ?? '', /\[\[Literal\]\]/);
  assert.equal(doc.querySelector('script'), null);
  const embed = await renderStaticPreview('![[image.png]]', 'Test.md', async () => '');
  assert.doesNotMatch(embed, /<a|data-note-target/);
  assert.doesNotMatch(sanitizePreview('<a href="https://evil.test" data-note-target="../Private.md">Bad</a>'), /<a|href|data-note/);
});

test('inline tags become inert navigation markers, not code, URLs or frontmatter', async () => {
  const html = await renderStaticPreview('---\ntags: [hidden]\n---\n#status/active and #work/plans. `#literal` https://example.test/#fragment and #123', 'Test.md', async () => '');
  const doc = new JSDOM(html).window.document;
  assert.deepEqual([...doc.querySelectorAll('a[data-tag-target]')].map(link =>
    [link.textContent, link.getAttribute('data-tag-target'), link.getAttribute('href')]),
    [['#status/active', 'status/active', '#tag'], ['#work/plans', 'work/plans', '#tag']]);
  assert.match(doc.querySelector('code')?.textContent ?? '', /#literal/);
  assert.doesNotMatch(html, /data-tag-target="hidden"|data-tag-target="literal"|data-tag-target="fragment"|data-tag-target="123"/);
  assert.doesNotMatch(sanitizePreview('<a href="#note" data-note-target="Canary" data-tag-target="work/plans">forged</a>'), /data-tag-target/);
});

test('markdown-style links to a vault note become note markers; other hrefs stay inert text', async () => {
  const html = await renderStaticPreview(
    'A [note](Folder/Other.md) and [here](./Other.md#Heading) and [web](https://evil.test/x) and [abs](/etc/passwd).',
    'Test.md', async () => '');
  const doc = new JSDOM(html).window.document;
  assert.deepEqual([...doc.querySelectorAll('a')].map(link =>
    [link.textContent, link.getAttribute('data-note-target'), link.getAttribute('href')]), [
    ['note', 'Folder/Other', '#note'],
    ['here', 'Other', '#note'],
  ]);
  // Non-vault links keep their label but lose the href entirely.
  assert.match(doc.body.textContent ?? '', /web/);
  assert.doesNotMatch(html, /evil\.test|passwd|#external/);
});

test('callouts become a typed container with the first line promoted to a title', async () => {
  const html = await renderStaticPreview(
    '> [!warning] Careful now\n> Body **text**.\n\n> [!note]\n> Untitled body.\n\n> [!bogus] Not a callout\n> plain quote.',
    'Test.md', async () => '');
  const doc = new JSDOM(html).window.document;
  const callouts = [...doc.querySelectorAll('.callout')];
  assert.equal(callouts.length, 2);
  assert.ok(callouts[0].classList.contains('callout-warning'));
  assert.match(callouts[0].textContent ?? '', /Careful now/);
  assert.match(callouts[0].textContent ?? '', /Body/);
  // An unknown type is left as an ordinary blockquote rather than inventing a class.
  assert.ok(doc.querySelector('blockquote'));
  assert.match(doc.querySelector('blockquote')?.textContent ?? '', /\[!bogus\]/);
});

test('the sanitizer accepts only renderer-emitted classes', async () => {
  const kept = sanitizePreview('<div class="callout callout-note">x</div><code class="language-txt">y</code>');
  assert.match(kept, /class="callout callout-note"/);
  assert.match(kept, /class="language-txt"/);
  const dropped = sanitizePreview('<div class="callout" style="position:fixed" onclick="x()">z</div><div class="evil user-controlled">w</div>');
  assert.doesNotMatch(dropped, /style=|onclick=|evil|user-controlled/);
});

test('inline images are rewritten by the host, never passed through', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const shown = await renderStaticPreview('![a diagram](diagram.png)', 'Note.md',
    async () => '', async () => ({ mime: 'image/png', base64: png }));
  assert.match(shown, new RegExp(`src="data:image/png;base64,${png}"`));
  assert.match(shown, /alt="a diagram"/);

  const unsupported = await renderStaticPreview('![a diagram](diagram.svg)', 'Note.md',
    async () => '', async () => null);
  assert.equal(unsupported.includes('<img'), false);
  assert.match(unsupported, /\[image not shown: a diagram\]/);

  let asked = 0;
  const remote = await renderStaticPreview('![x](https://evil.test/x.png)', 'Note.md',
    async () => '', async () => { asked += 1; return null; });
  assert.equal(asked, 0, 'a remote image must not even be resolved');
  assert.equal(remote.includes('<img'), false);
  assert.equal(remote.includes('evil.test'), false);

  const svg = await renderStaticPreview('![x](icon.svg)', 'Note.md',
    async () => '', async () => ({ mime: 'image/svg+xml', base64: 'PHN2Zz4=' }));
  assert.equal(svg.includes('<img'), false);
  assert.equal(svg.includes('image/svg+xml'), false);

  const missing = await renderStaticPreview('![x](missing.png)', 'Note.md',
    async () => '', async () => null);
  assert.equal(missing.includes('<img'), false);
  assert.match(missing, /image unavailable: x/);

  // Without a resolver the reference stays inert, which is the Dataview and static-result path.
  const unresolved = await renderStaticPreview('![x](diagram.png)', 'Note.md', async () => '');
  assert.equal(unresolved.includes('<img'), false);
});

test('inline and display maths become MathML the browser can render without fonts', async () => {
  const inline = await renderStaticPreview('Half of $x^2$ is here.', 'Math.md', async () => '');
  assert.match(inline, /<math>/);
  assert.match(inline, /<msup><mi>x<\/mi><mn[^>]*>2<\/mn><\/msup>/);
  // The dollars themselves are gone; the prose around them is not.
  assert.equal(inline.includes('$'), false);
  assert.match(inline, /Half of/);
  assert.match(inline, /is here\./);

  const display = await renderStaticPreview('$$\\sum_{i=1}^{n} i$$', 'Math.md', async () => '');
  assert.match(display, /<math[^>]*display="block"/);
  assert.match(display, /<munderover>/);
});

test('a dollar sign that is not maths is left exactly as written', async () => {
  // A note that documents shell variables must not have them eaten by the maths pass.
  const code = await renderStaticPreview('Run `echo $HOME` to see it.', 'Shell.md', async () => '');
  assert.match(code, /\$HOME/);
  assert.equal(code.includes('<math'), false);

  const fence = await renderStaticPreview('```sh\necho $PATH\n```', 'Shell.md', async () => '');
  assert.match(fence, /\$PATH/);
  assert.equal(fence.includes('<math'), false);

  const escaped = await renderStaticPreview('It costs \\$5 today.', 'Money.md', async () => '');
  assert.match(escaped, /\$5/);
  assert.equal(escaped.includes('<math'), false);
});

test('an expression that will not parse stays visible as the text the author typed', async () => {
  const html = await renderStaticPreview('Broken $\\frac{a}{$ here.', 'Broken.md', async () => '');
  assert.equal(html.includes('<math'), false);
  assert.match(html, /\$\\frac\{a\}\{\$/);
});

test('maths carries no style, class, href or annotation channel', async () => {
  const hostile = '$$x\\href{javascript:alert(1)}{y}$$';
  const html = await renderStaticPreview(hostile, 'Math.md', async () => '');
  assert.equal(/style=/.test(html), false);
  assert.equal(/href=/.test(html), false);
  assert.equal(/annotation/.test(html), false);
  assert.equal(/class="tml-/.test(html), false);

  // Markup written inside a note becomes escaped text inside the formula, never an element.
  const injected = await renderStaticPreview('$\\text{<a href="http://evil.test">x</a>}$',
    'Math.md', async () => '');
  assert.equal(/<a [^>]*href/.test(injected), false);
  assert.match(injected, /&lt;a/);
});

test('the maths pass is bounded so one note cannot monopolise the renderer', async () => {
  const many = Array.from({ length: 400 }, (_, i) => `$x_{${i}}$`).join(' ');
  const html = await renderStaticPreview(many, 'Many.md', async () => '');
  const count = (html.match(/<math>/g) ?? []).length;
  assert.ok(count <= 200, `expected at most 200 rendered expressions, got ${count}`);
  assert.ok(count > 0);
});

test('maths keeps the characters the author typed, which Markdown would otherwise eat', async () => {
  // A matrix row break is two backslashes. Rendering after Markdown unescaped them collapsed every
  // row into one, and TeX thin-space `\,` became a literal comma before the first user ever saw it.
  const matrix = await renderStaticPreview(
    '$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$', 'M.md', async () => '');
  assert.equal((matrix.match(/<mtr>/g) ?? []).length, 2);
  assert.equal((matrix.match(/<mtd>/g) ?? []).length, 4);

  const cases = await renderStaticPreview(
    '$$f(x) = \\begin{cases} x^2 & x \\ge 0 \\\\ -x & x < 0 \\end{cases}$$', 'M.md', async () => '');
  assert.equal((cases.match(/<mtr>/g) ?? []).length, 2);

  const integral = await renderStaticPreview(
    '$$\\int_0^\\infty e^{-x^2}\\,dx$$', 'M.md', async () => '');
  assert.match(integral, /<msubsup>/);
  assert.equal(/e<sup>|,&nbsp;/.test(integral), false);
  assert.equal((integral.match(/<\/mi>,/g) ?? []).length, 0);
});

test('maths inside a fenced block is code, not maths', async () => {
  const html = await renderStaticPreview('```latex\n$$x^2$$\n```', 'M.md', async () => '');
  assert.equal(html.includes('<math'), false);
  assert.match(html, /\$\$x\^2\$\$/);
});

/**
 * `![[picture.png]]` is Obsidian's image embed, and it used to render as
 * "[embedded note unavailable: … — not found in this vault]" — a false statement about the user's vault,
 * printed where their picture should be. Measured live on 2026-11-04 in the reading view.
 */
test('a wiki image embed renders as an image, resolved as a vault path', async () => {
  const asked: string[] = [];
  const html = await renderStaticPreview('![[Asset-Test/Raster.png]]', 'Notes/Demo.md',
    async () => '', async path => {
      asked.push(path);
      return { mime: 'image/png', base64: 'iVBORw0KGgo=' };
    });
  assert.deepEqual(asked, ['Asset-Test/Raster.png']);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(html, /not found in this vault/);
});

test('an image embed that cannot be read says so once, without claiming the note is missing', async () => {
  const html = await renderStaticPreview('![[gone.png]]', 'Demo.md', async () => '', async () => null);
  assert.match(html, /image unavailable/i);
  assert.doesNotMatch(html, /not found in this vault/);
});

test('an image embed survives the sanitiser with a data URL', async () => {
  const html = await renderStaticPreview('![[Raster.png|a picture]]', 'Demo.md', async () => '',
    async () => ({ mime: 'image/png', base64: 'iVBORw0KGgo=' }));
  const safe = sanitizePreview(html);
  assert.match(safe, /<img /);
  assert.match(safe, /data:image\/png;base64,/);
});

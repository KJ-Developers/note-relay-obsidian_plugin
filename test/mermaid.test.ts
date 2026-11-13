import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node,
  DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
});
const { sanitizeMermaidSvg } = await import('../src/mermaid-svg');
void dom;

const svg = (inner: string, attrs = '') =>
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  `viewBox="0 0 10 10"${attrs ? ' ' + attrs : ''}>${inner}</svg>`;

test('an ordinary Mermaid diagram survives with its shapes and colours', () => {
  const out = sanitizeMermaidSvg(svg(
    '<g class="node"><rect x="1" y="2" width="8" height="4" fill="#e8eef7" stroke="#333" />' +
    '<text x="3" y="5" font-family="sans-serif" font-size="12">A</text></g>'));
  assert.ok(out);
  assert.match(out, /<rect[^>]*fill="#e8eef7"/);
  assert.match(out, /<text[^>]*>A<\/text>/);
  assert.match(out, /<g class="node">/);
});

test('a script element is removed entirely, not just its handler attribute', () => {
  const out = sanitizeMermaidSvg(svg('<script>alert(1)</script><rect x="0" y="0" />'));
  assert.ok(out);
  assert.equal(/script/i.test(out), false);
  assert.match(out, /<rect/);
});

test('foreignObject is removed, because it re-enters HTML inside an SVG', () => {
  const out = sanitizeMermaidSvg(svg(
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject><circle r="2" />'));
  assert.ok(out);
  assert.equal(/foreignObject/i.test(out), false);
  assert.equal(/html/.test(out), false);
  assert.match(out, /<circle/);
});

test('an event handler never survives, whatever it is called', () => {
  const out = sanitizeMermaidSvg(svg(
    '<rect onclick="alert(1)" onmouseover="alert(2)" onbegin="alert(3)" />'));
  assert.ok(out);
  assert.equal(/on[a-z]+=/i.test(out), false);
});

test('an external reference is refused; an internal one is kept', () => {
  const out = sanitizeMermaidSvg(svg(
    '<use xlink:href="https://evil.test/x.svg#a" /><use xlink:href="#local" />'));
  assert.ok(out);
  assert.equal(/evil\.test/.test(out), false);
  assert.match(out, /#local/);
});

test('a style attribute keeps presentation properties and rejects the rest', () => {
  const kept = sanitizeMermaidSvg(svg('<rect style="fill:#ff0;stroke-width:2" />'));
  assert.ok(kept);
  assert.match(kept, /fill:#ff0/);

  // A declaration that could position, fetch or compute loses the whole attribute.
  for (const hostile of [
    'position:fixed;inset:0', 'fill:url(https://evil.test/x)',
    "background:url('javascript:1')",
    'fill:expression(alert(1))', 'behavior:url(#default#time2)',
    "background-image:image-set('x')",
  ]) {
    const out = sanitizeMermaidSvg(svg(`<rect style="${hostile}" />`));
    assert.ok(out, `expected output for ${hostile}`);
    assert.equal(/style=/i.test(out), false, `expected ${hostile} to be stripped`);
  }
});

test('a style element is dropped, because an inline stylesheet reaches the whole document', () => {
  const out = sanitizeMermaidSvg(svg('<style>*{position:fixed;inset:0}</style><rect />'));
  assert.ok(out);
  assert.equal(/<style/i.test(out), false);
  assert.match(out, /<rect/);
});

test('an unknown element and an unknown attribute are both dropped', () => {
  const out = sanitizeMermaidSvg(svg('<rect data-evil="1" onload="x" foo="bar" />'));
  assert.ok(out);
  assert.equal(/data-evil|foo=|onload/i.test(out), false);
});

test('the svg root itself keeps its viewBox, which is what makes it scale', () => {
  const out = sanitizeMermaidSvg(svg('<rect />'));
  assert.ok(out);
  assert.match(out, /viewBox="0 0 10 10"/i);
});

test('input that is not SVG is refused rather than half-parsed', () => {
  // Malformed markup yields null too: a half-parsed document is not something to render.
  for (const input of ['', 'not markup', '<div>html</div>', '<svg>', '<svg><rect style="a:"b""></svg>']) {
    assert.equal(sanitizeMermaidSvg(input), null, `expected ${JSON.stringify(input)} to be refused`);
  }
});

test('an oversized diagram is refused instead of sent', () => {
  const huge = sanitizeMermaidSvg(svg(`<text>${'x'.repeat(300 * 1024)}</text>`));
  assert.equal(huge, null);
});

test('a comment cannot smuggle an element back in', () => {
  const out = sanitizeMermaidSvg(svg('<!-- <script>alert(1)</script> --><rect />'));
  assert.ok(out);
  assert.equal(/script/i.test(out), false);
});

test('a diagram is not damaged by the HTML sanitiser that runs after it', async () => {
  // DOMPurify drops SVG attributes wholesale with a plain tag allow-list, which reduced a rendered
  // diagram to an empty box. Diagrams therefore leave and re-enter around it.
  const { extractDiagrams, restoreDiagrams } = await import('../src/mermaid-svg');
  const page = `<p>before</p>${svg('<g><text x="3">Note</text><rect fill="#123456"/></g>')}<p>after</p>`;
  const { html, diagrams } = extractDiagrams(page);
  assert.equal(diagrams.length, 1);
  assert.equal(html.includes('<svg'), false);
  const restored = restoreDiagrams(html, diagrams);
  assert.match(restored, /viewBox="0 0 10 10"/);
  assert.match(restored, />Note</);
  assert.match(restored, /fill="#123456"/);
  assert.match(restored, /before/);
  assert.match(restored, /after/);
});

test('a diagram keeps the max-width Mermaid sized it with', () => {
  // Without it the SVG stretches to the full reading width, and a tall flowchart then overflows its
  // card so only the first node is visible.
  const out = sanitizeMermaidSvg(svg('<rect />', 'style="max-width: 206.75px;"'));
  assert.ok(out);
  assert.match(out, /max-width:\s*206\.75px/);
});

test('the Mermaid loader asks Obsidian to load its own bundle instead of injecting a script', async () => {
  const { MarkdownRenderer } = await import('obsidian');
  const { makeMermaidRenderer } = await import('../src/mermaid');

  // The review flags runtime script creation as arbitrary code execution. This asserts the loader
  // cannot do it even accidentally: `window.mermaid` is installed by Obsidian's own renderer, and no
  // element with the tag `script` is ever created.
  const created: string[] = [];
  const realCreate = dom.window.document.createElement.bind(dom.window.document);
  (dom.window.document as any).createElement = (tag: string, ...rest: unknown[]) => {
    created.push(tag);
    return (realCreate as any)(tag, ...rest);
  };
  (dom.window.Element.prototype as any).createDiv = function createDiv(options?: { cls?: string }) {
    const element = dom.window.document.createElement('div');
    if (options?.cls) element.className = options.cls;
    this.appendChild(element);
    return element;
  };
  (globalThis as any).activeDocument = dom.window.document;

  const initialised: Array<Record<string, unknown>> = [];
  (MarkdownRenderer as any).render = async () => {
    (dom.window as any).mermaid = {
      initialize(options: Record<string, unknown>) { initialised.push(options); },
      async render() { return { svg: null }; },
    };
  };

  const renderer = makeMermaidRenderer({} as any);
  await renderer('graph TD; A-->B;');

  assert.ok(!created.includes('script'), 'the loader created a script element');
  assert.equal(initialised.length, 1, 'Obsidian\'s Mermaid API was never configured');
  assert.equal(initialised[0].htmlLabels, false);
});

import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { extractMath, substituteMath } from './math';
import { expandTransclusions, wrapEmbeds } from './transclusion';
import type { EmbedResolver } from './transclusion';
import { extractDiagrams, MAX_MERMAID_BLOCKS, restoreDiagrams } from './mermaid-svg';
import type { MermaidRenderer } from './mermaid';

const MAX_PREVIEW_SOURCE = 128 * 1024;
const MAX_DQL_BLOCKS = 10;
const MAX_DQL_QUERY = 4 * 1024;
const MAX_DQL_RESULT = 128 * 1024;

const tags = [
  'div', 'span', 'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 's', 'del', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img',
  // MathML, exactly the elements Temml emits for the expressions in the test corpus.
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mover', 'munder', 'munderover',
  'menclose',
];

/**
 * MathML attributes, again derived from real Temml output.
 *
 * `style` and `class` are deliberately absent: Temml emits both for typographic fallbacks we do not
 * ship CSS for, and a style attribute in note content is exactly the kind of channel this renderer
 * exists to not have. `display` carries block-vs-inline, which is the only layout fact that matters.
 */
const MATHML_ELEMENTS = new Set([
  'MATH', 'MROW', 'MI', 'MN', 'MO', 'MTEXT', 'MSPACE', 'MSUP', 'MSUB', 'MSUBSUP',
  'MFRAC', 'MSQRT', 'MROOT', 'MTABLE', 'MTR', 'MTD', 'MOVER', 'MUNDER', 'MUNDEROVER',
  'MENCLOSE',
]);
const MATHML_ATTRS = [
  'display', 'displaystyle', 'fence', 'form', 'height', 'lspace', 'movablelimits',
  'notation', 'rspace', 'stretchy', 'width', 'columnalign', 'rowalign', 'columnspacing',
  'rowspacing', 'columnlines', 'frame', 'equalrows', 'linethickness', 'scriptlevel',
  'maxsize', 'minsize', 'symmetric', 'largeop', 'accent', 'accentunder', 'mathvariant',
  'voffset', 'depth',
];

// No Obsidian postprocessors, raw HTML, external links, or remote media. The `link` rule is
// re-enabled below but every href is forced through a vault-relative `.md` check, and the
// sanitiser unwraps anything that is not a vault note, so no external href ever survives.
const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.disable(['autolink']);
const staticMarkdown = new MarkdownIt({ html: false, linkify: false });
staticMarkdown.disable(['image', 'autolink']);

/** Approved raster types for inline display. Anything else stays a placeholder. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const MAX_INLINE_IMAGES = 20;
const MAX_INLINE_IMAGE_BYTES = 256 * 1024;

/**
 * Resolves a vault-relative image reference to a data URL, or null to leave a placeholder.
 * Supplied by the adapter, which owns vault access; absent in tests and for static Dataview results.
 */
export type ImageResolver = (src: string) => Promise<{ mime: string; base64: string } | null>;

/** Obsidian callout kinds. A closed set, so a class name can never be author-controlled. */
const CALLOUT_TYPES = new Set(['abstract', 'bug', 'caution', 'danger', 'error', 'example', 'failure',
  'important', 'info', 'note', 'question', 'quote', 'success', 'summary', 'tip', 'todo', 'warning']);
// Callouts, the Dataview wrapper, and markdown-it's own `language-*` code fence classes.
const CALLOUT_CLASS =
  /^(?:callout|callout-[a-z]{1,20}|block-language-dataview|language-[a-z0-9+#._-]{1,40}|embed|mermaid-diagram)$/;

/**
 * Emits an inline image from an already-validated data URL.
 *
 * The markup is built here, not parsed from note text: the `src` is constructed from a whitelisted
 * MIME type and a base64 payload we produced, and the alt text is escaped by markdown-it's own
 * escaping. Author HTML never reaches this path because `html: false` and the sanitiser both hold.
 */
markdown.renderer.rules.nr_math = (tokens, index) => tokens[index].content;

markdown.renderer.rules.nr_image = (tokens, index) => {
  const token = tokens[index];
  const src = String(token.attrGet('src') ?? '');
  const alt = String(token.attrGet('alt') ?? '');
  if (!src.startsWith('data:image/')) return escapeHtml(alt);
  return `<img src="${src}" alt="${escapeHtml(alt)}" loading="lazy">`;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

/** Only classes the renderer itself emits, so `class` can stay allowed without becoming a channel. */
export function validPreviewClass(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length > 0 && parts.length <= 3 && parts.every(part => CALLOUT_CLASS.test(part));
}

function validLinkTarget(target: string): boolean {
  return target.length > 0 && target.length <= 512 && !/[%\\:\u0000-\u001f\u007f]/u.test(target) &&
    !target.startsWith('/') && !target.includes('//') &&
    target.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/**
 * `![[picture.png]]` — an image embed in Obsidian's own syntax.
 *
 * Markdown has no rule for it (its `image` rule wants `![alt](src)`), so the token is emitted here and
 * resolved after parsing, next to the `![](path)` images. Before this, a wiki image embed fell into the
 * transclusion pass, which reported "not found in this vault" in place of the picture.
 */
markdown.inline.ruler.before('image', 'vault_embed_image', (state, silent) => {
  const start = state.pos;
  if (state.src.slice(start, start + 3) !== '![[') return false;
  const end = state.src.indexOf(']]', start + 3);
  if (end < 0 || end - start > 516) return false;
  const body = state.src.slice(start + 3, end);
  const [destination, label] = body.split('|', 2);
  const target = destination.trim();
  // Only formats the raster command can return; svg and pdf stay text rather than becoming frames.
  if (!/\.(png|jpe?g|gif|webp)$/i.test(target) || !validLinkTarget(target)) return false;
  if (!silent) {
    const token = state.push('nr_embed_image', '', 0);
    token.content = target;
    token.attrSet('alt', (label || target.split('/').at(-1) || target).slice(0, 512));
  }
  state.pos = end + 2;
  return true;
});

// Emit navigation markers as parser tokens. Note text and labels are escaped by MarkdownIt.
markdown.inline.ruler.before('link', 'vault_wikilink', (state, silent) => {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== '[[' || (start > 0 && state.src[start - 1] === '!')) return false;
  const end = state.src.indexOf(']]', start + 2);
  if (end < 0 || end - start > 516) return false;
  const body = state.src.slice(start + 2, end);
  const [destination, label] = body.split('|', 2);
  const target = destination.split('#', 1)[0].trim();
  if (!validLinkTarget(target)) return false;
  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrSet('href', '#note');
    open.attrSet('data-note-target', target);
    state.push('text', '', 0).content = label || target.split('/').at(-1) || target;
    state.push('link_close', 'a', -1);
  }
  state.pos = end + 2;
  return true;
});

function validTagTarget(target: string): boolean {
  return target.length > 0 && target.length <= 128 &&
    /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(target) && /[\p{L}_-]/u.test(target);
}

markdown.inline.ruler.before('emphasis', 'vault_tag', (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== '#' || (start > 0 && !/[\s([{]/u.test(state.src[start - 1]))) return false;
  const match = /^#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/u.exec(state.src.slice(start));
  if (!match || !validTagTarget(match[1])) return false;
  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrSet('href', '#tag');
    open.attrSet('data-tag-target', match[1]);
    state.push('text', '', 0).content = match[0];
    state.push('link_close', 'a', -1);
  }
  state.pos = start + match[0].length;
  return true;
});

/** Strips `.md` and a fragment, then re-validates, so only a vault-relative note survives. */
function markdownNoteTarget(href: string): string | null {
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  const bare = decoded.split('#', 1)[0].replace(/^\.\//u, '');
  if (!/\.md$/iu.test(bare)) return null;
  const target = bare.replace(/\.md$/iu, '');
  return validLinkTarget(target) ? target : null;
}

/**
 * `[label](Note.md)` becomes the same navigation marker `[[Note]]` produces. Any other href is
 * marked dead and the sanitiser unwraps the anchor to its label, so an external or absolute URL
 * can never reach the browser as a link. Obsidian rendered these clickable; we keep the text.
 */
type MarkdownInstance = InstanceType<typeof MarkdownIt>;
// Structural shapes for the token stream, so this does not depend on how markdown-it's
// type declarations are resolved across its dist and index entry points.
type RulerToken = { type: string; tag: string; content: string; children?: RulerToken[] | null;
  attrSet(name: string, value: string): void; attrGet(name: string): string | null };
type RulerState = { tokens: RulerToken[] };

/**
 * markdown-it types its core-ruler callbacks against its own internal token classes, which do
 * not line up across the dist and index entry points. The structural shape is what actually
 * arrives at runtime, so the registration is cast once here rather than at every rule.
 */
function afterRule(md: MarkdownInstance, stage: string, name: string, rule: (state: RulerState) => void): void {
  (md.core.ruler.after as unknown as (stage: string, name: string, fn: (state: RulerState) => void) => void)(stage, name, rule);
}

function convertMarkdownLinks(md: MarkdownInstance): void {
  afterRule(md, 'inline', 'vault_md_links', state => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      for (const child of token.children) {
        if (child.type !== 'link_open') continue;
        // [[wikilinks]] and #tags already carry their marker; only bare markdown links
        // are converted, so this rule can never overwrite one that is already correct.
        if (child.attrGet('data-note-target') !== null || child.attrGet('data-tag-target') !== null) continue;
        const target = markdownNoteTarget(child.attrGet('href') ?? '');
        if (target) {
          child.attrSet('href', '#note');
          child.attrSet('data-note-target', target);
        } else {
          child.attrSet('href', '#external');
        }
      }
    }
  });
}

/**
 * `> [!note] Title` becomes a callout the way Obsidian draws it: a div carrying a fixed class
 * for the type, with the rest of the first line promoted to the title. The type must be in a
 * closed set, so the class attribute is never author-controlled.
 */
function convertCallouts(md: MarkdownInstance): void {
  afterRule(md, 'block', 'vault_callouts', state => {
    const tokens = state.tokens;
    for (let start = 0; start < tokens.length; start++) {
      if (tokens[start].type !== 'blockquote_open') continue;
      let depth = 0; let end = -1;
      for (let index = start; index < tokens.length; index++) {
        if (tokens[index].type === 'blockquote_open') depth += 1;
        else if (tokens[index].type === 'blockquote_close') {
          depth -= 1;
          if (depth === 0) { end = index; break; }
        }
      }
      if (end < 0) continue;
      const body = tokens.slice(start + 1, end).find(token => token.type === 'inline');
      if (!body) continue;
      const marker = /^\[!([A-Za-z]{1,20})\][+-]?[ \t]*/u.exec(body.content);
      if (!marker) continue;
      const kind = marker[1].toLowerCase();
      if (!CALLOUT_TYPES.has(kind)) continue;
      tokens[start].tag = 'div';
      tokens[start].attrSet('class', `callout callout-${kind}`);
      tokens[end].tag = 'div';
      const rest = body.content.slice(marker[0].length);
      const breakAt = rest.indexOf('\n');
      const title = (breakAt < 0 ? rest : rest.slice(0, breakAt)).trim();
      const remainder = breakAt < 0 ? '' : rest.slice(breakAt + 1);
      // A hard break (two trailing spaces) puts the title on its own line; the callout body is
      // a single inline token, so a blank line here would not create a second paragraph.
      const join = title && remainder ? '  \n' : '\n';
      body.content = `${title ? `**${title}**` : ''}${remainder ? `${title ? join : ''}${remainder}` : ''}` || ' ';
    }
  });
}

convertMarkdownLinks(markdown);
convertCallouts(markdown);
convertMarkdownLinks(staticMarkdown);
convertCallouts(staticMarkdown);

function taskMarkers(source: string): string {
  return source.replace(/^(\s*[-*+]\s+)\[([ xX])\]\s+/gm, (_, prefix: string, status: string) =>
    `${prefix}${status.toLowerCase() === 'x' ? '☑' : '☐'} `);
}

function staticWikiLabels(source: string): string {
  return source.replace(/\[\[([^\]\r\n]{1,512})\]\]/g, (_, target: string) => {
    const label = target.split('|').at(-1) ?? target;
    return label.split('#').at(-1) ?? label;
  });
}

/** Strips a leading frontmatter block; an embedded note's properties are not inlined. */
export function withoutEmbeddedFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source;
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

function withoutFrontmatter(source: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source;
  const lines = source.split(/\r?\n/u);
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === '---' || lines[index] === '...') return lines.slice(index + 1).join('\n');
  }
  return source;
}

/** Sanitises the page, with inline SVG handled by `mermaid-svg.ts` rather than by DOMPurify. */
export function sanitizePreview(html: string): string {
  const { html: withoutDiagrams, diagrams } = extractDiagrams(html);
  return restoreDiagrams(sanitizeHtmlOnly(withoutDiagrams), diagrams);
}

function sanitizeHtmlOnly(html: string): string {
  const safe = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['class', 'colspan', 'rowspan', 'href', 'data-note-target', 'data-tag-target',
      'src', 'alt', ...MATHML_ATTRS],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
  const wrapper = document.createElement('div');
  wrapper.appendChild(safe);
  for (const element of wrapper.querySelectorAll('*')) {
    const noteLink = element.tagName === 'A' && element.getAttribute('href') === '#note' &&
      validLinkTarget(element.getAttribute('data-note-target') ?? '');
    const tagLink = element.tagName === 'A' && element.getAttribute('href') === '#tag' &&
      validTagTarget(element.getAttribute('data-tag-target') ?? '');
    for (const attr of Array.from(element.attributes)) {
      if (attr.name === 'class') {
        if (!validPreviewClass(attr.value)) element.removeAttribute(attr.name);
      } else if (attr.name === 'href' || attr.name === 'data-note-target' || attr.name === 'data-tag-target') {
        if (!(attr.name === 'href' && (noteLink || tagLink) ||
          attr.name === 'data-note-target' && noteLink || attr.name === 'data-tag-target' && tagLink))
          element.removeAttribute(attr.name);
      } else if (attr.name === 'src') {
        // Only an img, and only a data raster this renderer built — never a URL or a path.
        if (element.tagName !== 'IMG' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(attr.value)) {
          element.removeAttribute(attr.name);
        }
      } else if (attr.name === 'alt') {
        if (element.tagName !== 'IMG' || attr.value.length > 512 ||
            /[\u0000-\u001f\u007f]/u.test(attr.value)) {
          element.removeAttribute(attr.name);
        }
      } else if (MATHML_ELEMENTS.has(element.tagName.toUpperCase()) &&
          MATHML_ATTRS.includes(attr.name)) {
        // Bounded and quote-free: these carry numbers and keywords, never markup.
        if (attr.value.length > 40 || /[<>&"']/.test(attr.value)) element.removeAttribute(attr.name);
      } else if (attr.name === 'colspan' || attr.name === 'rowspan') {
        const n = Number(attr.value);
        if (!Number.isInteger(n) || n < 1 || n > 20) element.removeAttribute(attr.name);
      } else {
        element.removeAttribute(attr.name);
      }
    }
  }
  for (const link of wrapper.querySelectorAll('a')) {
    if (!link.hasAttribute('href') || !(link.hasAttribute('data-note-target') || link.hasAttribute('data-tag-target')))
      link.replaceWith(...Array.from(link.childNodes));
  }
  // An image that lost its src is removed with the element: an <img> with no validated source is a
  // broken frame. This runs after the attribute pass, which is what strips an untrusted src.
  for (const image of wrapper.querySelectorAll('img')) {
    if (!image.getAttribute('src')) image.remove();
  }
  return wrapper.innerHTML;
}

export type DqlQuery = (query: string, originFile: string) => Promise<string>;

/**
 * Resolves `![[picture.png]]` tokens collected by the inline rule.
 *
 * The target is a vault path exactly as the author wrote it, so it is resolved as-is — unlike a Markdown
 * image, which is relative to the note. One budget with `![](…)` images would be better still, but this
 * pass runs after that one and each is bounded on its own, so a note cannot exceed either limit.
 */
async function resolveEmbedImages(tokens: ReturnType<typeof markdown.parse>,
  resolve: ImageResolver): Promise<void> {
  let resolved = 0;
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (const child of token.children) {
      if (child.type !== 'nr_embed_image') continue;
      const target = String(child.content);
      const alt = String(child.attrGet('alt') ?? target);
      const extension = target.split('.').pop()?.toLowerCase() ?? '';
      const mime = IMAGE_MIME[extension];
      if (!mime || resolved >= MAX_INLINE_IMAGES) {
        child.type = 'text'; child.tag = ''; child.attrs = [];
        child.content = `[image unavailable: ${alt}]`;
        continue;
      }
      const image = await resolve(target).catch(() => null);
      if (image && image.mime === mime) {
        child.type = 'nr_image'; child.tag = '';
        child.attrs = [['src', `data:${image.mime};base64,${image.base64}`], ['alt', alt]];
        child.content = '';
        resolved += 1;
      } else {
        child.type = 'text'; child.tag = ''; child.attrs = [];
        child.content = `[image unavailable: ${alt}]`;
      }
    }
  }
}

/**
 * Replaces `image` tokens with either a `nr_image` token carrying a resolved data URL, or plain text
 * naming the file. A note that references an unavailable or oversized image renders as readable text
 * rather than a broken frame or a silent gap.
 */
async function resolveImages(tokens: ReturnType<typeof markdown.parse>, originFile: string,
  resolve: ImageResolver): Promise<void> {
  const folder = originFile.includes('/') ? originFile.slice(0, originFile.lastIndexOf('/') + 1) : '';
  let resolved = 0;
  let attempted = 0;
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (const child of token.children) {
      if (child.type !== 'image') continue;
      attempted += 1;
      const raw = String(child.attrGet('src') ?? '');
      const alt = String(child.content || child.attrGet('alt') || raw);
      const extension = raw.split('.').pop()?.toLowerCase() ?? '';
      const relative = raw.startsWith('/') ? raw.slice(1) : `${folder}${raw}`;
      const allowed = !raw.includes('://') && !!IMAGE_MIME[extension] && resolved < MAX_INLINE_IMAGES;
      const image = allowed ? await resolve(relative) : null;
      if (image && image.mime === IMAGE_MIME[extension]) {
        child.type = 'nr_image';
        child.tag = '';
        child.attrs = [['src', `data:${image.mime};base64,${image.base64}`], ['alt', alt]];
        resolved += 1;
      } else {
        // Keep the reference visible and honest instead of dropping it.
        child.type = 'text';
        child.tag = '';
        child.attrs = [];
        child.content = allowed || attempted > MAX_INLINE_IMAGES
          ? `[image unavailable: ${alt}]` : `[image not shown: ${alt}]`;
      }
    }
  }
}

export async function renderStaticPreview(source: string, originFile: string, runDql: DqlQuery,
  resolveImage?: ImageResolver, resolveNote?: EmbedResolver,
  renderMermaid?: MermaidRenderer): Promise<string> {
  if (new TextEncoder().encode(source).length > MAX_PREVIEW_SOURCE) throw new Error('Preview source too large');
  // Transclusion runs first, so maths and Dataview inside an embedded note are rendered by the same
  // pass as the outer note rather than being shown as their own syntax.
  const embeds = await expandTransclusions(taskMarkers(withoutFrontmatter(source)),
    async target => {
      // A raster embed belongs to the image path; resolving it here would inline an image as text.
      if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(target)) return null;
      if (!resolveNote) return null;
      const found = await resolveNote(target);
      return found === null ? null : taskMarkers(withoutEmbeddedFrontmatter(found));
    }, { originFile, leave: target => /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(target) });
  const math = extractMath(embeds.source);
  const tokens = markdown.parse(math.source, {});
  const dql = tokens.filter(token => token.type === 'fence' && token.info.trim().toLowerCase() === 'dataview');
  if (dql.length > MAX_DQL_BLOCKS || dql.some(token => new TextEncoder().encode(token.content).length > MAX_DQL_QUERY)) {
    throw new Error('Dataview query limit exceeded');
  }
  if (resolveImage) await resolveImages(tokens, originFile, resolveImage);
  if (resolveImage) await resolveEmbedImages(tokens, resolveImage);
  if (renderMermaid) {
    const diagrams = tokens.filter(token => token.type === 'fence' &&
      token.info.trim().toLowerCase().split(/\s+/)[0] === 'mermaid');
    for (const [index, token] of diagrams.entries()) {
      // Bounded, and a diagram that will not render is shown as its own source — which is what the
      // author wrote and what they can fix.
      const svg = index < MAX_MERMAID_BLOCKS ? await renderMermaid(token.content) : null;
      if (!svg) continue;
      token.type = 'html_block';
      token.content = `<div class="mermaid-diagram">${svg}</div>`;
    }
  }
  for (const token of dql) {
    const result = await runDql(token.content, originFile);
    if (typeof result !== 'string') throw new Error('Invalid Dataview result');
    if (new TextEncoder().encode(result).length > MAX_DQL_RESULT) throw new Error('Dataview result too large');
    token.type = 'html_block';
    token.content = `<div class="block-language-dataview">${staticMarkdown.render(taskMarkers(staticWikiLabels(result)))}</div>`;
  }
  // The embed count and the skipped list are not returned: the caller renders one note, and the
  // visible placeholders already say what was left out.
  void embeds.embedded; void embeds.skipped;
  return sanitizePreview(substituteMath(
    wrapEmbeds(markdown.renderer.render(tokens, markdown.options, {})), math.math));
}

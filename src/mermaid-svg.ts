// SVG sanitising for Mermaid output — pure, so it can be tested without Obsidian.
/** One diagram's source is bounded; a pasted generative diagram is not a note. */
export const MAX_MERMAID_SOURCE = 8 * 1024;
/** Diagrams per note. */
export const MAX_MERMAID_BLOCKS = 10;
/** The SVG a diagram becomes, bounded so one diagram cannot become a large transfer. */
export const MAX_MERMAID_SVG = 256 * 1024;

/** SVG elements kept. Mermaid emits shapes, text, paths and groups; nothing here can run. */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'marker', 'clippath', 'title', 'desc', 'use', 'style',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'symbol',
]);

/** Attributes kept on any kept element. */
const SVG_ATTRS = new Set([
  'class', 'id', 'width', 'height', 'viewbox', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
  'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'marker-start', 'marker-end',
  'marker-mid', 'orient', 'refx', 'refy', 'markerwidth', 'markerheight', 'markerunits', 'style',
  'dx', 'dy', 'textlength', 'lengthadjust', 'font-variant', 'writing-mode', 'stroke-miterlimit',
  'stop-color', 'stop-opacity', 'offset', 'gradientunits', 'gradienttransform', 'patterntransform',
  'patternunits', 'spreadmethod', 'vector-effect',
  'xmlns', 'xmlns:xlink', 'xlink:href', 'role', 'aria-label', 'aria-roledescription',
  'preserveaspectratio',
]);

/**
 * A `style` element is kept, because Mermaid's theme lives in one and dropping it leaves an unstyled
 * diagram. Its rules are filtered rather than trusted: each selector must be scoped to this diagram's
 * own id, and each declaration must be a presentation property.
 */
function safeStyleSheet(css: string, diagramId: string): string {
  const rules: string[] = [];
  for (const block of css.split('}')) {
    const brace = block.indexOf('{');
    if (brace === -1) continue;
    const selector = block.slice(0, brace).trim();
    // Scope is required: a rule that is not tied to this diagram could restyle the whole document.
    if (!selector.includes(`#${diagramId}`)) continue;
    const declarations = safeStyle(block.slice(brace + 1));
    if (declarations) rules.push(`${selector}{${declarations}}`);
  }
  return rules.join('');
}

/** CSS properties a `style` attribute may carry — presentation only, nothing that positions or loads. */
const SVG_STYLE_PROPS = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'color', 'font-family',
  'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'shape-rendering', 'paint-order', 'white-space',
  // Mermaid sizes a diagram with `max-width` on the root, and without it the SVG stretches to the
  // full reading width — a tall flowchart then overflows its card and only the first node is visible.
  'max-width', 'max-height',
]);

/** Elements and attributes that appear only in a hostile diagram. */
const DROP_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate',
  'animatetransform', 'animatemotion', 'set', 'handler', 'listener']);

/** A style attribute's declarations, or null when any of them is not presentation-only. */
function safeStyle(value: string): string | null {
  const declarations: string[] = [];
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) return null;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const raw = trimmed.slice(colon + 1).trim();
    if (!SVG_STYLE_PROPS.has(property)) return null;
    // A value must not reach out or compute anything: no url(), no var(), no expression().
    // No allowed property takes a function, so any parenthesis is a computed or loaded value.
    if (/[<>{}()]|expression|@import|javascript:/i.test(raw)) return null;
    declarations.push(`${property}:${raw}`);
  }
  return declarations.length === 0 ? null : declarations.join(';');
}

/**
 * Reduces a Mermaid SVG to inert, presentation-only markup.
 *
 * `DOMPurify` is not used here because its SVG profile is broader than this renderer's contract:
 * `use` and internal fragment references are needed, `foreignObject` never is, and the decision about
 * a `style` attribute is about which properties, not whether the attribute is allowed at all.
 */
export function sanitizeMermaidSvg(input: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(input, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;

  const walk = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const name = child.tagName.toLowerCase();
      if (DROP_ELEMENTS.has(name) || !SVG_TAGS.has(name)) { child.remove(); continue; }
      walk(child);
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (!SVG_ATTRS.has(name)) { element.removeAttribute(attribute.name); continue; }
      if (name === 'style') {
        const style = safeStyle(value);
        if (style) element.setAttribute('style', style); else element.removeAttribute('style');
        continue;
      }
      // `href` only as an internal fragment: an external reference is a load, however it is spelled.
      if (name === 'xlink:href' || name === 'href') {
        if (!value.startsWith('#')) element.removeAttribute(attribute.name);
        continue;
      }
      // No event handler can be named in this allow-list, but a value must never carry markup either.
      if (/[<>]/.test(value)) element.removeAttribute(attribute.name);
    }
  };
  walk(root);

  // The visible diagram's root carries an id; its stylesheet must be scoped to exactly that.
  const diagramId = root.getAttribute('id') ?? '';
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const filtered = diagramId ? safeStyleSheet(style.textContent ?? '', diagramId) : '';
    if (filtered.length === 0) style.remove();
    else style.textContent = filtered;
  }
  // Comments carry no rendered content and can hold text a reader never sees; remove them all,
  // including one that is a direct child of the root.
  const comments: Node[] = [];
  const finder = doc.createTreeWalker(root, 128 /* SHOW_COMMENT */);
  while (finder.nextNode()) comments.push(finder.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);

  const out = new XMLSerializer().serializeToString(root);
  if (out.length > MAX_MERMAID_SVG) return null;
  return out;
}


const OPEN_SVG = '<svg';
const CLOSE_SVG = '</svg>';
export const SVG_SLOT_OPEN = '\uE010';
export const SVG_SLOT_CLOSE = '\uE011';

/**
 * Replaces every inline SVG with a placeholder, keeping its sanitised markup aside.
 *
 * A diagram cannot pass through DOMPurify: with a plain tag allow-list it drops SVG attributes
 * wholesale, which turned a rendered diagram into an empty, attribute-less box. Extracting the
 * diagrams first keeps that library's policy and this renderer's policy from fighting.
 */
export function extractDiagrams(html: string): { html: string; diagrams: string[] } {
  const diagrams: string[] = [];
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = html.indexOf(OPEN_SVG, cursor);
    if (start === -1) break;
    const end = html.indexOf(CLOSE_SVG, start);
    if (end === -1) break;
    out += html.slice(cursor, start);
    const safe = sanitizeMermaidSvg(html.slice(start, end + CLOSE_SVG.length));
    if (safe) {
      out += `${SVG_SLOT_OPEN}${diagrams.length}${SVG_SLOT_CLOSE}`;
      diagrams.push(safe);
    }
    cursor = end + CLOSE_SVG.length;
  }
  out += html.slice(cursor);
  return { html: out, diagrams };
}

/** Puts the sanitised diagrams back where their placeholders are. */
export function restoreDiagrams(html: string, diagrams: string[]): string {
  if (diagrams.length === 0) return html;
  return html.replace(/\uE010(\d+)\uE011/g,
    (whole, index: string) => diagrams[Number(index)] ?? whole);
}

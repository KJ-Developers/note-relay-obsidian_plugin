// TeX → MathML for the note preview.
//
// The host renders math itself and sends the browser inert markup, for the same reason Dataview runs
// on the vault side: the browser holds no renderer, no fonts and no scripts from the note.
//
// Temml is the right converter here rather than KaTeX. KaTeX emits HTML that depends on its own CSS
// and webfonts, and the reading frame's policy is `font-src 'none'` — so KaTeX would render as
// missing glyphs. Temml emits MathML, which the browser renders natively with no fonts at all.
import temml from 'temml';

/** One expression is bounded so a pathological note cannot turn rendering into a CPU sink. */
export const MAX_TEX_LENGTH = 500;
/** The MathML for one expression is bounded too; a huge matrix would otherwise be unbounded markup. */
export const MAX_MATHML_LENGTH = 20_000;
/** A note with thousands of expressions is not a note we should be spending the main thread on. */
export const MAX_EXPRESSIONS = 200;

/**
 * Renders one TeX expression to MathML, or returns null so the caller can leave the source visible.
 *
 * Failing to null rather than to an error box is deliberate: an unparseable expression in someone's
 * note should look like the text they typed, not like a broken product.
 */
export function renderMath(tex: string, display: boolean): string | null {
  const source = tex.trim();
  if (source.length === 0 || source.length > MAX_TEX_LENGTH) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return null;
  try {
    const mathml = temml.renderToString(source, {
      displayMode: display, throwOnError: true, strict: false,
    });
    if (typeof mathml !== 'string' || !mathml.startsWith('<math')) return null;
    if (mathml.length > MAX_MATHML_LENGTH) return null;
    return mathml;
  } catch {
    return null;
  }
}

/** Placeholders are private-use characters, which Markdown passes through untouched. */
const MARKER = /\uE000(\d+)\uE001/g;

/**
 * Extracts `$$...$$` and `$...$` from the note source before Markdown parses it.
 *
 * Rendering afterwards loses the source: markdown-it unescapes backslashes, so a matrix row break
 * (`\\`) arrives at the converter as a single backslash and the matrix collapses into one row, and
 * TeX spacing like `\,` becomes a literal comma. Extracting first keeps every character the author
 * typed. Fenced blocks and inline code are skipped, so a note that documents `$HOME` keeps it.
 */
export function extractMath(source: string): { source: string; math: Map<string, string> } {
  const math = new Map<string, string>();
  const lines = source.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let index = 0;

  const render = (tex: string, display: boolean): string | null => {
    if (math.size >= MAX_EXPRESSIONS) return null;
    const mathml = renderMath(tex, display);
    if (!mathml) return null;
    const key = `\uE000${index++}\uE001`;
    math.set(key, mathml);
    return key;
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; out.push(line); continue; }
    out.push(protectCodeSpans(line, render));
  }
  return { source: out.join('\n'), math };
}

/** Copies inline code verbatim and looks for maths only between code spans. */
function protectCodeSpans(line: string,
  render: (tex: string, display: boolean) => string | null): string {
  let result = '';
  let cursor = 0;
  while (cursor < line.length) {
    const tick = line.indexOf('`', cursor);
    const stop = tick === -1 ? line.length : tick;
    result += replaceMath(line.slice(cursor, stop), render);
    if (tick === -1) break;
    const close = line.indexOf('`', tick + 1);
    const end = close === -1 ? line.length : close + 1;
    result += line.slice(tick, end);
    cursor = end;
  }
  return result;
}

/** Replaces maths delimiters in one non-code run of text, leaving anything unparseable as typed. */
function replaceMath(text: string,
  render: (tex: string, display: boolean) => string | null): string {
  const pattern = /(\\*)(\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$)/g;
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    // An odd number of backslashes escapes the dollar: it is money, not maths.
    if (match[1].length % 2 === 1) continue;
    const display = match[3] !== undefined;
    const tex = display ? match[3] : match[4];
    const replacement = render(tex, display);
    if (replacement === null) continue;
    result += text.slice(cursor, match.index) + replacement;
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor);
}

/** Puts the rendered MathML back in place of its placeholders, after Markdown has run. */
export function substituteMath(html: string, math: Map<string, string>): string {
  if (math.size === 0) return html;
  return html.replace(MARKER, whole => math.get(whole) ?? whole);
}

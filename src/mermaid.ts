// Mermaid diagrams, rendered by the Mermaid that Obsidian already loads.
//
// Obsidian ships Mermaid as `/lib/mermaid.min.js` and initialises it with `securityLevel: 'strict'`
// (see the app bundle's loader). Bundling Mermaid into this plugin instead would add about 5 MB to
// `main.js` — parsed on every Obsidian startup, for a feature most notes never use — so the installed
// renderer is used, exactly as Dataview is.
//
// The output is still SVG in note content, which is the one markup form that can carry script and
// external references, so `mermaid-svg.ts` reduces it to presentation only before it leaves the host.
import { MAX_MERMAID_SOURCE, sanitizeMermaidSvg } from './mermaid-svg';

export type MermaidRenderer = (code: string) => Promise<string | null>;

/** The slice of Mermaid's API used here, so this file needs no dependency on its types. */
type MermaidApi = {
  initialize(options: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg?: unknown }>;
};

/** Obsidian loads Mermaid lazily; this is the path it uses. */
const MERMAID_SCRIPT = '/lib/mermaid.min.js';
/** A diagram that takes longer than this is not rendered: a preview must never hang on one fence. */
const RENDER_TIMEOUT_MS = 5_000;

import { hasControlCharacterOtherThanLineWhitespace } from './characters';

let sequence = 0;
let initialised = false;

function mermaidApi(): MermaidApi | null {
  const api = (window as unknown as { mermaid?: MermaidApi }).mermaid;
  return api && typeof api.render === 'function' ? api : null;
}

/**
 * Loads Obsidian's own Mermaid bundle if the preview has not already pulled it in.
 *
 * The script comes from the application, not from a network host: it is the same file Obsidian uses
 * for every `mermaid` fence in its reading view.
 */
async function ensureMermaid(): Promise<MermaidApi | null> {
  const present = mermaidApi();
  if (present) {
    // Obsidian initialises Mermaid with its own defaults the first time it needs a diagram, and its
    // default is HTML labels — which become `foreignObject`, the one SVG element this renderer
    // refuses. Our settings are applied on every path, not only when the script had to be loaded.
    configure(present);
    return present;
  }
  await new Promise<void>(resolve => {
    // Same trap as the appearance probe: Document.createEl appends to the document node on
    // Obsidian 1.14.5 and throws. Create the element and append it to head explicitly.
    const script = activeDocument.createElement('script');
    script.src = MERMAID_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    activeDocument.head.appendChild(script);
    window.setTimeout(resolve, RENDER_TIMEOUT_MS);
  });
  const loaded = mermaidApi();
  if (loaded) configure(loaded);
  return loaded;
}

/** The settings this renderer needs. Applied once per session, on whichever path found the API. */
function configure(api: MermaidApi): void {
  if (initialised) return;
  initialised = true;
  api.initialize({
    startOnLoad: false,
    // Same security level Obsidian uses, so the diagram is built by the same code path.
    securityLevel: 'strict',
    // Text labels rather than HTML: Mermaid's HTML labels are wrapped in <foreignObject>, which the
    // sanitiser refuses, and a diagram with no visible labels is worse than no diagram.
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    themeVariables: { fontFamily: 'inherit' },
  });
}

/** Mermaid creates a scratch element named `d<id>` and removes it on success; make sure it goes. */
function cleanScratch(id: string): void {
  activeDocument.getElementById(`d${id}`)?.remove();
}

/**
 * Renders one Mermaid source, then sanitises the SVG.
 *
 * Every failure path returns null, and the caller leaves the fence visible as its own source: a
 * diagram that cannot be drawn should look like the text the author wrote, not like a broken image.
 */
export function makeMermaidRenderer(): MermaidRenderer {
  return async (code: string): Promise<string | null> => {
    const source = code.trim();
    if (source.length === 0 || source.length > MAX_MERMAID_SOURCE) return null;
    if (hasControlCharacterOtherThanLineWhitespace(source)) return null;

    const api = await ensureMermaid();
    if (!api) return null;

    sequence += 1;
    const id = `nr-mermaid-${sequence}`;
    try {
      const result = await Promise.race([
        api.render(id, source),
        new Promise<null>(resolve => window.setTimeout(() => resolve(null), RENDER_TIMEOUT_MS)),
      ]);
      const svg = result && typeof result.svg === 'string' ? result.svg : null;
      if (!svg) { cleanScratch(id); return null; }
      return sanitizeMermaidSvg(svg);
    } catch {
      cleanScratch(id);
      return null;
    }
  };
}

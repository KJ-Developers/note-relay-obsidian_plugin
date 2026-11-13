// Mermaid diagrams, rendered by the Mermaid that Obsidian already loads.
//
// Obsidian ships Mermaid as `/lib/mermaid.min.js` and initialises it with `securityLevel: 'strict'`
// (see the app bundle's loader). Bundling Mermaid into this plugin instead would add about 5 MB to
// `main.js` — parsed on every Obsidian startup, for a feature most notes never use — so the installed
// renderer is used, exactly as Dataview is.
//
// The output is still SVG in note content, which is the one markup form that can carry script and
// external references, so `mermaid-svg.ts` reduces it to presentation only before it leaves the host.
import { Component, MarkdownRenderer, type App } from 'obsidian';
import { MAX_MERMAID_SOURCE, sanitizeMermaidSvg } from './mermaid-svg';
import { wait } from './timers';

export type MermaidRenderer = (code: string) => Promise<string | null>;

/** The slice of Mermaid's API used here, so this file needs no dependency on its types. */
type MermaidApi = {
  initialize(options: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg?: unknown }>;
};

/** How long to wait for Obsidian to finish loading its own Mermaid. Short on purpose: see below. */
const LOAD_TIMEOUT_MS = 1_500;
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
 * Asks Obsidian to load its own Mermaid, without this plugin creating a script element.
 *
 * The directory review flags runtime `createElement('script')` as arbitrary code execution, and it is
 * right to: a scanner cannot tell an application-local file from a network host. Obsidian already
 * knows how to load Mermaid — it does it the first time its markdown renderer meets a mermaid fence —
 * so the honest way to ask is to give it a fence and throw the result away. `window.mermaid` is set by
 * that load, and everything after this point is unchanged.
 */
async function warmUpMermaid(app: App | undefined): Promise<void> {
  if (!app) return;
  const host = activeDocument.body.createDiv({ cls: 'note-relay-mermaid-warmup' });
  const component = new Component();
  component.load();
  try {
    void MarkdownRenderer.render(app, '```mermaid\ngraph TD;\nA-->B;\n```', host, '', component);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (!mermaidApi() && Date.now() < deadline) await wait(50);
  } catch { /* A renderer that refuses is the same outcome as a timeout: the fence stays as source. */ }
  finally {
    component.unload();
    host.remove();
  }
}

/**
 * One attempt per session.
 *
 * Each preview asks for Mermaid, and a note can carry a dozen fences. Without this, a vault whose
 * session has never loaded Mermaid paid the timeout once per fence — measured at 70 seconds for one
 * note, which the browser reports as "Reading …" and never recovers from inside its 10-second read
 * window. One attempt, one short wait, then every later preview answers immediately.
 */
let loadAttempted = false;

async function ensureMermaid(app: App | undefined): Promise<MermaidApi | null> {
  const present = mermaidApi();
  if (present) {
    // Obsidian initialises Mermaid with its own defaults the first time it needs a diagram, and its
    // default is HTML labels — which become `foreignObject`, the one SVG element this renderer
    // refuses. Our settings are applied on every path, not only when the script had to be loaded.
    configure(present);
    return present;
  }
  if (!loadAttempted) {
    loadAttempted = true;
    await warmUpMermaid(app);
  }
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
export function makeMermaidRenderer(app?: App): MermaidRenderer {
  return async (code: string): Promise<string | null> => {
    const source = code.trim();
    if (source.length === 0 || source.length > MAX_MERMAID_SOURCE) return null;
    if (hasControlCharacterOtherThanLineWhitespace(source)) return null;

    const api = await ensureMermaid(app);
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

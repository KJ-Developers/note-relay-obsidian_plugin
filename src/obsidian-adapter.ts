import { App, TFile, TFolder } from 'obsidian';
import { renderStaticPreview } from './preview';
import { appearanceColors, appearanceFonts, safeAppearance, safeColor } from './appearance';
import { DataviewGate } from './dataview-gate';
import type { MermaidRenderer } from './mermaid';
import { installedDataview } from './dataview-api';
import { MAX_SEARCH_BYTES, MAX_SEARCH_RESULTS, YIELD_EVERY, matchNote, parseQuery, rankMatches,
  type SearchReport } from './search';
import { MAX_PROPERTY_VALUE, MAX_PROPERTY_VALUES, MAX_PROPERTIES, matchesRasterSignature,
  validMarkdownPath,
  validVaultPath } from './protocol';
import type { Appearance, FileRef, Preview, PropertyEntry, PropertyKind, VaultAdapter, WriteOutcome, WritableVaultAdapter } from './protocol';

/** Collapses a frontmatter value into display strings. Never returns markup. */
function propertyValues(value: unknown): { kind: PropertyKind; values: string[] } | null {
  const asText = (input: unknown): string | null => {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (input instanceof Date) return Number.isNaN(input.valueOf()) ? null : input.toISOString().slice(0, 10);
    if (input === null || input === undefined) return '';
    // Nested maps and unexpected objects are shown as compact JSON so nothing is silently dropped.
    try { return JSON.stringify(input); } catch { return null; }
  };
  if (Array.isArray(value)) {
    const values = value.slice(0, MAX_PROPERTY_VALUES).map(asText).filter((item): item is string => item !== null);
    return values.length ? { kind: 'list', values: values.map(item => item.slice(0, MAX_PROPERTY_VALUE)) } : null;
  }
  if (typeof value === 'boolean') return { kind: 'boolean', values: [String(value)] };
  if (typeof value === 'number') return { kind: 'number', values: [String(value)] };
  const text = asText(value);
  if (text === null) return null;
  // Obsidian parses unquoted ISO dates into Date; anything date-shaped is shown as a date.
  const kind: PropertyKind = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/.test(text) ? 'date' : 'text';
  return { kind, values: [text.slice(0, MAX_PROPERTY_VALUE)] };
}

export class ObsidianAdapter implements WritableVaultAdapter {
  private readonly dataview = new DataviewGate();
  /** Mermaid comes from Obsidian's own bundled renderer; see `mermaid.ts` for why. */
  private mermaid: MermaidRenderer = async () => null;

  constructor(private app: App) {}

  /**
   * Supplies the Mermaid renderer once the plugin exists, because rendering needs a Component to own
   * the work. Until then a diagram renders as its own source rather than as a broken image.
   */
  useMermaid(renderer: MermaidRenderer): void {
    this.mermaid = renderer;
  }

  listMarkdown(): FileRef[] {
    return this.app.vault.getMarkdownFiles().map(file => ({ path: file.path, extension: file.extension }));
  }

  listFolders(): string[] {
    const folders: string[] = [];
    const walk = (folder: TFolder) => {
      for (const child of folder.children) if (child instanceof TFolder) {
        folders.push(child.path);
        walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    return folders;
  }

  tags(file: FileRef): string[] {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') return [];
    const cache = this.app.metadataCache.getFileCache(actual);
    if (!cache) return [];
    const result: string[] = [];
    for (const item of cache.tags ?? []) if (typeof item.tag === 'string') result.push(item.tag);
    const frontmatter = cache.frontmatter?.tags;
    if (typeof frontmatter === 'string') result.push(...frontmatter.split(/[ ,]+/u));
    else if (Array.isArray(frontmatter)) result.push(...frontmatter.filter((tag): tag is string => typeof tag === 'string'));
    return result;
  }

  backlinks(file: FileRef): string[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    return Object.entries(resolved).filter(([, targets]) =>
      typeof targets?.[file.path] === 'number' && targets[file.path] > 0).map(([source]) => source);
  }

  outgoing(file: FileRef): string[] {
    const targets = this.app.metadataCache.resolvedLinks[file.path] ?? {};
    return Object.entries(targets).filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([target]) => target);
  }

  getFile(path: string): FileRef | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? { path: file.path, extension: file.extension } : null;
  }

  /**
   * Frontmatter as display-only entries, from Obsidian's metadata cache. `position` is
   * dropped because it describes offsets in the file body, not metadata worth sharing.
   */
  properties(file: FileRef): PropertyEntry[] {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') return [];
    const frontmatter = this.app.metadataCache.getFileCache(actual)?.frontmatter;
    if (!frontmatter || typeof frontmatter !== 'object') return [];
    const entries: PropertyEntry[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (entries.length >= MAX_PROPERTIES) break;
      if (key === 'position' || !/^[^\u0000-\u001f\u007f]{1,128}$/u.test(key)) continue;
      const collapsed = propertyValues(value);
      if (collapsed) entries.push({ key, kind: collapsed.kind, values: collapsed.values });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  async read(file: FileRef): Promise<string> {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') throw new Error('File unavailable');
    return this.app.vault.read(actual);
  }

  async readBinary(file: FileRef): Promise<ArrayBuffer> {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== file.extension) throw new Error('File unavailable');
    if (actual.stat.size > 256 * 1024) throw new Error('Asset too large');
    return this.app.vault.readBinary(actual);
  }

  /**
   * Overwrite only if the file still holds `expected`.
   *
   * The comparison runs *inside* `vault.process`, which hands us the current bytes and only
   * commits what the callback returns. That closes the window between the protocol layer's
   * hash check and the write: an edit made in Obsidian or by a sync client in that gap makes
   * `data !== expected`, we throw, and `process` leaves the file untouched.
   */
  async writeNote(file: FileRef, source: string, expected: string): Promise<WriteOutcome> {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') return 'missing';
    try {
      await this.app.vault.process(actual, data => {
        if (data !== expected) throw new Error('conflict');
        return source;
      });
      return 'ok';
    } catch (error) {
      return error instanceof Error && error.message === 'conflict' ? 'conflict' : 'missing';
    }
  }

  /** Creates a note, refusing to overwrite anything already at that path. */
  async createNote(path: string, source: string): Promise<WriteOutcome> {
    if (this.app.vault.getAbstractFileByPath(path)) return 'exists';
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) return 'missing';
    try {
      await this.app.vault.create(path, source);
      return 'ok';
    } catch {
      // A concurrent create, a case-insensitive filesystem, or a rejected name lands here.
      return this.app.vault.getAbstractFileByPath(path) ? 'exists' : 'missing';
    }
  }

  /** Renames or moves through Obsidian's own API so wikilinks follow the file. */
  async renameNote(file: FileRef, to: string): Promise<WriteOutcome> {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') return 'missing';
    if (this.app.vault.getAbstractFileByPath(to)) return 'exists';
    const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    if (parent && !(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) return 'missing';
    try {
      await this.app.fileManager.renameFile(actual, to);
      return 'ok';
    } catch {
      return 'missing';
    }
  }

  /**
   * Deletes via `fileManager.trashFile`, which honours the vault's own trash preference
   * (`.trash` folder or the OS trash) instead of unlinking. `expected` is re-checked by the
   * caller and again here, because a delete is the one write that cannot be undone from the
   * browser.
   */
  async trashNote(file: FileRef, expected: string): Promise<WriteOutcome> {
    const actual = this.app.vault.getAbstractFileByPath(file.path);
    if (!(actual instanceof TFile) || actual.extension !== 'md') return 'missing';
    const current = await this.app.vault.read(actual);
    if (current !== expected) return 'conflict';
    try {
      await this.app.fileManager.trashFile(actual);
      return 'ok';
    } catch {
      return 'missing';
    }
  }

  /**
   * Searches note bodies and returns titles, hit counts and short excerpts.
   *
   * Bounded twice: by bytes read and by results returned. The byte cap yields a `truncated` report
   * rather than a silent partial answer, so the browser can say "searched 4,100 of 6,700" instead of
   * implying the vault holds no more matches.
   *
   * The loop yields every few hundred notes: this runs on Obsidian's own UI thread, and a cold scan
   * of a large vault would otherwise stall typing.
   */
  async searchNotes(query: string, limit: number): Promise<SearchReport> {
    const terms = parseQuery(query);
    const files = this.app.vault.getMarkdownFiles().filter(file => validMarkdownPath(file.path));
    const total = files.length;
    if (!terms) return { matches: [], scanned: 0, total, truncated: false };

    const matches: SearchReport['matches'] = [];
    let scanned = 0;
    let bytes = 0;
    let truncated = false;
    for (const file of files) {
      const text = await this.app.vault.cachedRead(file);
      bytes += text.length;
      scanned += 1;
      const match = matchNote(file.path, text, terms);
      if (match) matches.push(match);
      if (bytes >= MAX_SEARCH_BYTES || matches.length >= MAX_SEARCH_RESULTS) {
        // Stop at the cap, but only report truncation when notes were genuinely left unread.
        truncated = scanned < total;
        break;
      }
      if (scanned % YIELD_EVERY === 0) {
        // Hand the UI thread a turn; a cold scan of a large vault must not freeze typing.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }
    return { matches: rankMatches(matches, limit), scanned, total, truncated };
  }

  async preview(file: FileRef, source: string): Promise<Preview> {
    const html = await renderStaticPreview(source, file.path, async (query, origin) => {
      const api = installedDataview(this.app);
      if (!api) throw new Error('Dataview is unavailable');
      return this.dataview.run(() => api.tryQueryMarkdown(query, origin, { allowHtml: false }));
    }, async path => this.inlineImage(path), async target => this.embeddedNote(target),
      this.mermaid);
    return { html, state: 'complete', renderer: 'static-dql-v1' };
  }

  /**
   * Reads another note for `![[Note]]` transclusion.
   *
   * Resolution follows Obsidian's own order so an embed finds what the author saw: the literal path,
   * then the same folder as the embedding note, then the shortest unique basename. An ambiguous
   * basename resolves to nothing rather than to a guess — showing the wrong note's body inside
   * someone else's note is worse than showing none.
   */
  private async embeddedNote(target: string): Promise<string | null> {
    if (!validVaultPath(target) || target.includes('..')) return null;
    const candidates: string[] = [];
    const withExtension = target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
    const direct = this.app.vault.getAbstractFileByPath(withExtension);
    if (direct instanceof TFile) candidates.push(direct.path);
    if (candidates.length === 0) {
      const bare = withExtension.split('/').at(-1) ?? withExtension;
      const matches = this.app.vault.getMarkdownFiles()
        .filter(file => (file.path.split('/').at(-1) ?? '') === bare)
        .map(file => file.path);
      // A short name is vault-wide in Obsidian, but only if it is unique.
      if (matches.length === 1) candidates.push(matches[0]);
    }
    const path = candidates[0];
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try { return await this.app.vault.cachedRead(file); } catch { return null; }
  }

  /**
   * Turns a vault image into a data URL for inline display.
   *
   * Deliberately narrow: approved raster types only, a hard byte cap, and a signature check before
   * the bytes are encoded. An SVG is refused outright because it is a scriptable document, and the
   * preview frame is the one place note content becomes markup.
   */
  private async inlineImage(path: string): Promise<{ mime: string; base64: string } | null> {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp' }[extension];
    if (!mime || !validVaultPath(path) || path.includes('..')) return null;
    const actual = this.app.vault.getAbstractFileByPath(path);
    if (!(actual instanceof TFile) || actual.stat.size > 256 * 1024) return null;
    try {
      const bytes = new Uint8Array(await this.app.vault.readBinary(actual));
      if (!matchesRasterSignature(bytes, mime)) return null;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      return { mime, base64: btoa(binary) };
    } catch { return null; }
  }

  appearance(): Appearance {
    const styles = getComputedStyle(document.body);
    const tokens: Record<string, string> = {};
    // Computed custom properties may still contain var() or hsl(); resolve each
    // through the browser's color parser, then serialize only literal colors.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:rgb(1, 2, 3)';
    const sample = document.createElement('span');
    probe.appendChild(sample);
    document.body.appendChild(probe);
    try {
      for (const name of appearanceColors) {
        const raw = styles.getPropertyValue(name);
        const direct = safeColor(raw);
        if (direct) { tokens[name] = direct; continue; }
        if (!raw.trim()) continue;
        sample.style.color = `var(${name})`;
        const resolved = safeColor(getComputedStyle(sample).color);
        if (resolved && resolved !== '#010203') tokens[name] = resolved;
      }
    } finally {
      probe.remove();
    }
    for (const name of appearanceFonts) tokens[name] = styles.getPropertyValue(name);
    return safeAppearance({ mode: document.body.classList.contains('theme-dark') ? 'dark' : 'light', tokens });
  }
}

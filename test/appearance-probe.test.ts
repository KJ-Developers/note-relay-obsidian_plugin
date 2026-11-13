import test from 'node:test';
import assert from 'node:assert/strict';
import { ObsidianAdapter } from '../src/obsidian-adapter';

/**
 * Obsidian 1.14.5's Document.createEl/createSpan append to the document node itself and throw
 * "HierarchyRequestError: Only one element on document allowed". On 0.2.3 the colour probe was built
 * with `activeDocument.createSpan(...)`, so that throw became RENDER_FAILED for every vault: no theme,
 * and a reader that saw an empty vault. The fix builds the probe on `activeDocument.body`, where the
 * element-level helpers are unaffected.
 *
 * This test stands in for that browser: the document-level helpers throw exactly as 1.14.5 does, and
 * only the element-level ones work. A regression to `activeDocument.createSpan` fails here first,
 * which is the whole point — the failure it produces in the field looks like "vault is empty".
 */
test('the appearance probe is built on the body, because document-level helpers throw on Obsidian 1.14.5', () => {
  const removed: any[] = [];

  const element = (tag = 'span'): any => {
    const node: any = {
      tag,
      style: {},
      className: '',
      children: [] as any[],
      classList: { contains: (name: string) => name === 'theme-dark' },
      createSpan(options: { cls?: string } = {}) {
        const child = element('span');
        if (options.cls) child.className = options.cls;
        child.parent = node;
        node.children.push(child);
        return child;
      },
      appendChild(child: any) {
        child.parent = node;
        node.children.push(child);
        return child;
      },
      // remove() has to unlink from the parent as a real DOM node does, or "the probe was removed"
      // would pass while the body kept growing.
      remove() {
        removed.push(node);
        if (node.parent) {
          const at = node.parent.children.indexOf(node);
          if (at >= 0) node.parent.children.splice(at, 1);
          node.parent = null;
        }
      },
      parent: null as any,
    };
    return node;
  };

  const body = element('body');
  const head = element('head');
  const onDocument = () => {
    throw new Error('HierarchyRequestError: Only one element on document allowed');
  };

  (globalThis as any).activeDocument = {
    body,
    head,
    // The 1.14.5 trap. Element-level helpers above stay usable.
    createSpan: onDocument,
    createEl: onDocument,
    createElement: (tag: string) => element(tag),
    getElementById: () => null,
  };
  (globalThis as any).getComputedStyle = (node: any) => ({
    getPropertyValue: (name: string) => {
      if (name === '--background-primary') return '#101820';
      if (name === '--text-normal') return 'rgb(224, 232, 240)';
      if (name === '--font-text') return 'Inter';
      return '';
    },
    color: '',
  });

  const adapter = new ObsidianAdapter({} as any);
  const appearance = adapter.appearance();

  // The two colours the stub resolves, and the font it declares, all survive the round trip.
  assert.equal(appearance.tokens['--background-primary'], '#101820');
  assert.equal(appearance.tokens['--text-normal'], '#e0e8f0');
  assert.equal(appearance.tokens['--font-text'], 'Inter');
  assert.equal(appearance.mode, 'dark');

  // The probe lived on the body and was taken away again: appearance runs on every connect, and a
  // probe left behind would accumulate in the vault's reading view.
  assert.equal(body.children.length, 0, 'the probe was not removed from the body');
  assert.ok(removed.length >= 1, 'nothing was removed, so the probe never left the body');
});

/**
 * Character validators for text the plugin accepts from Obsidian, the worker or the browser.
 *
 * These replace the regular expressions that used to embed literal control-character ranges in
 * every call site (patterns like `[\\u0000-\\u001f\\u007f]`). Each helper reproduces exactly the
 * accept/reject set of the pattern it replaces — same code-unit scanning, same ranges — so the
 * validation boundary at every call site is unchanged; only the spelling moved here.
 */

/** Tab, newline and carriage return: the three C0 codes some validators deliberately allow. */
const LINE_WHITESPACE = new Set<number>([0x09, 0x0a, 0x0d]);

/**
 * True when `value` contains any C0 control code (0x00–0x1F, tab, newline and carriage return
 * included) or DEL (0x7F) — exactly the set `[\u0000-\u001f\u007f]` matched, per code unit.
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `value` contains a C0 control code other than tab, newline or carriage return, or
 * DEL (0x7F) — exactly the set `[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]` matched.
 */
export function hasControlCharacterOtherThanLineWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && !LINE_WHITESPACE.has(code))) return true;
  }
  return false;
}

/** Removes every code `hasControlCharacter` would flag — `replace(/[\u0000-\u001f\u007f]/g, '')`. */
export function withoutControlCharacters(value: string): string {
  let kept = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) continue;
    kept += value[index];
  }
  return kept;
}

/**
 * Number of code points in `value` — what a `/u`-flagged `{1,n}` quantifier counts, where a
 * surrogate pair is one character and a lone surrogate is one character.
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

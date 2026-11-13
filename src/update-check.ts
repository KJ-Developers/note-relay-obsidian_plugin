/**
 * Version comparison for the "a newer Note Relay is available" notice.
 *
 * Kept in its own module with no Obsidian import so it is testable without the plugin host: importing
 * `main.ts` into a test drags in Modal, Plugin and the whole adapter surface.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3)
    .map(part => Number.parseInt(part, 10)).map(value => Number.isFinite(value) ? value : 0);
  const next = parse(candidate); const now = parse(current);
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > now[index]) return true;
    if (next[index] < now[index]) return false;
  }
  return false;
}

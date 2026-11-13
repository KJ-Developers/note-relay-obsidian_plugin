/**
 * Timers for modules that run inside Obsidian and also under plain Node in the test suite.
 *
 * Obsidian asks plugins to use the window's timer functions so a popout window owns its own timers;
 * plain Node has no `window`, and these modules are loaded by `node --test`. Hoisting the decision
 * here means one place chooses and every call site stays honest — a bare `setTimeout` is not
 * popout-safe, and a bare `window.setTimeout` would throw before a single test ran.
 */

type Schedule = (handler: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;
type TimerScope = { setTimeout: Schedule; clearTimeout: Cancel };

/** The window's timers inside Obsidian; the platform's under Node. */
const scope = (typeof window === 'undefined' ? global : window) as unknown as TimerScope;

export function setTimer(handler: () => void, ms: number): unknown {
  return scope.setTimeout(handler, ms);
}

export function clearTimer(handle: unknown): void {
  scope.clearTimeout(handle);
}

/** A promise that settles after `ms`, on whichever timer scope this environment provides. */
export function wait(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimer(resolve, ms); });
}

// How long to wait before re-opening the signalling socket.
//
// The socket used to retry on a flat five seconds. That is twelve attempts a minute against a budget of
// sixty per ten minutes — six a minute — so a single host in a retry loop could exhaust its own public
// IP's allowance and refuse the browser behind it. The browser can only report that as close code 1006
// with no reason, which is why it read as a client bug for an hour during the Stage 3 check.
//
// Exponential with jitter and a ceiling:
//   * exponential, because a network that is down stays down longer than six seconds;
//   * jittered, because two machines behind one router must not retry in step and share one budget
//     twice as fast;
//   * capped, so a vault that is hosting for hours still recovers within two minutes of the network
//     returning.

export const MIN_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 120_000;
/** The server says how long to wait; its value wins, within these bounds. */
export const MAX_SERVER_HINT_MS = 10 * 60_000;

/**
 * The delay before attempt number `attempt` (1 for the first retry).
 *
 * `random` is injectable so a test can assert the bounds without asserting a particular value.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  // Double per attempt, from the minimum, and stop doubling once past the ceiling.
  const ceiling = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(step - 1, 10));
  // "Equal jitter": half the ceiling is fixed, half is random, so the delay never collapses to a
  // thundering herd of short waits but also never grows without bound.
  const half = ceiling / 2;
  const jittered = half + random() * half;
  return Math.max(MIN_RETRY_MS, Math.min(MAX_RETRY_MS, Math.round(jittered)));
}

/**
 * The delay to use when the server refused the connection and said how long to wait.
 *
 * A `retry-after <seconds>` close reason is honoured exactly, because the server knows when its own
 * window resets and guessing shorter only earns another refusal.
 */
export function serverHintedDelay(reason: string | undefined): number | null {
  if (typeof reason !== 'string') return null;
  const match = /retry-after\s+(\d{1,4})/i.exec(reason);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(seconds * 1000, MAX_SERVER_HINT_MS);
}

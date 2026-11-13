import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RETRY_MS, MAX_SERVER_HINT_MS, MIN_RETRY_MS, reconnectDelay, serverHintedDelay }
  from '../src/reconnect';

test('the first retry waits at least the minimum and never past the ceiling', () => {
  for (const random of [0, 0.001, 0.5, 0.999, 1]) {
    const delay = reconnectDelay(1, () => random);
    assert.ok(delay >= MIN_RETRY_MS, `${delay} below the minimum`);
    assert.ok(delay <= MAX_RETRY_MS, `${delay} above the ceiling`);
  }
});

test('the delay grows with each attempt, so an outage does not hammer the server', () => {
  // Measured at the midpoint of the jitter, so the comparison is about the growth, not the randomness.
  const mid = () => 0.5;
  const delays = [1, 2, 3, 4, 5, 6].map(attempt => reconnectDelay(attempt, mid));
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1],
      `attempt ${index + 1} (${delays[index]}ms) should not be shorter than attempt ${index} (${delays[index - 1]}ms)`);
  }
  assert.ok(delays[5] > delays[0], 'the sixth delay should be longer than the first');
});

test('the delay is capped, so a long outage still recovers promptly', () => {
  for (const attempt of [10, 20, 50, 1000, 1e6]) {
    const delay = reconnectDelay(attempt, () => 0.999);
    assert.ok(delay <= MAX_RETRY_MS, `attempt ${attempt} produced ${delay}ms`);
  }
});

test('attempts within one ten-minute window stay inside the signal budget', () => {
  // The real defect this replaces: a flat 5s retry is 12 attempts a minute against a budget of 6.
  // Count how many retries fall inside ten minutes at the worst case for each attempt count.
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < 10 * 60_000) {
    attempts += 1;
    if (attempts > 500) break;
    // The shortest possible delay, which is the worst case for the budget.
    elapsed += reconnectDelay(attempts, () => 0);
  }
  assert.ok(attempts <= 40,
    `a ten-minute outage should cost at most ~40 attempts, got ${attempts}`);
});

test('a missing or malformed attempt number is treated as the first', () => {
  for (const attempt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = reconnectDelay(attempt, () => 0.5);
    assert.ok(delay >= MIN_RETRY_MS && delay <= MAX_RETRY_MS, `got ${delay} for ${attempt}`);
  }
});

test('jitter actually varies, so two hosts on one router do not retry in step', () => {
  const values = new Set([0, 0.25, 0.5, 0.75].map(v => reconnectDelay(3, () => v)));
  assert.ok(values.size > 1, 'the delay must vary with the random input');
});

test('a server hint is honoured exactly, because it knows when its window resets', () => {
  assert.equal(serverHintedDelay('retry-after 45'), 45_000);
  assert.equal(serverHintedDelay('retry-after 1'), 1_000);
  // Bounded, so a hostile or buggy reason cannot park a host for hours.
  assert.equal(serverHintedDelay('retry-after 99999'), MAX_SERVER_HINT_MS);
});

test('a close reason without a usable hint yields null, so the caller falls back to backoff', () => {
  for (const reason of ['', 'retry-after', 'retry-after 0', 'retry-after -5', 'go away',
    'Session ended', undefined, 'retry-after abc']) {
    assert.equal(serverHintedDelay(reason), null, `expected ${JSON.stringify(reason)} to give no hint`);
  }
});

test('a hint is found when the server includes other words around it', () => {
  assert.equal(serverHintedDelay('Rate limited; retry-after 30 please'), 30_000);
});

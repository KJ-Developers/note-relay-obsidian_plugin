import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READER_WAIT_GRACE_MS, ReaderWaitMonitor } from '../src/host-waiting';

/** A clock the test advances, so an eight-second grace costs no real time. */
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.run(); }
      }
    },
    get pending(): number { return timers.size; },
  };
}

function monitor(clock: ReturnType<typeof fakeClock>) {
  const changes: boolean[] = [];
  const wait = new ReaderWaitMonitor({
    onChange: waiting => changes.push(waiting),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { wait, changes };
}

test('a host that never sees a frame claims nothing, however long it waits', () => {
  // The limit made explicit: with no browser attached to the room there is no frame, and the plugin
  // must not turn "the vault is not hosting" into a notice it cannot prove.
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  clock.advance(READER_WAIT_GRACE_MS * 100);
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, []);
  assert.equal(clock.pending, 0);
});

test('a reader still attached after the grace period is reported waiting, once', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  assert.equal(wait.isWaiting, false, 'arrival alone is a handshake in progress, not a claim');
  clock.advance(READER_WAIT_GRACE_MS - 1);
  assert.equal(wait.isWaiting, false);
  clock.advance(1);
  assert.equal(wait.isWaiting, true);
  assert.deepEqual(changes, [true]);
});

test('a stuck reader that keeps renegotiating is reported once, not once per frame', () => {
  // A stalled reader re-sends offers; a notice per offer would be a toast storm on the owner's screen.
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  for (let round = 0; round < 5; round += 1) {
    wait.readerArrived();
    clock.advance(READER_WAIT_GRACE_MS);
  }
  assert.equal(wait.isWaiting, true);
  assert.deepEqual(changes, [true]);
});

test('a handshake that completes inside the grace period never reports, even later', () => {
  // The false positive this design exists to avoid: an ordinary read must raise nothing at all.
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(1_000);
  wait.connected();
  clock.advance(READER_WAIT_GRACE_MS * 10);
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, []);
  assert.equal(clock.pending, 0, 'the pending timer must be cancelled, not left to fire');
});

test('finishing the proof over the data channel clears a waiting reader', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  assert.equal(wait.isWaiting, true);
  wait.connected();
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, [true, false]);
});

test('a reader that leaves before the grace period aborts quietly', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS - 1_000);
  wait.readerLeft();
  clock.advance(READER_WAIT_GRACE_MS * 2);
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, []);
});

test('a reader that leaves while it is waiting is cleared', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  wait.readerLeft();
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(clock.pending, 0);
});

test('hosting stopping or the host socket closing clears the waiting state', () => {
  // Both meanings of "the host can no longer observe the room" must end the claim: the status bar
  // must not describe a reader while nothing is listening for one.
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  assert.equal(wait.isWaiting, true);
  wait.disconnected();
  assert.equal(wait.isWaiting, false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(clock.pending, 0);
});

test('a reader that comes back and stalls again is reported again', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  wait.readerLeft();
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  assert.deepEqual(changes, [true, false, true]);
});

test('every transition is announced exactly once, and repeats are silent', () => {
  const clock = fakeClock();
  const { wait, changes } = monitor(clock);
  wait.connected();
  wait.readerLeft();
  wait.disconnected();
  assert.deepEqual(changes, [], 'clearing what was never set is not a transition');
  wait.readerArrived();
  clock.advance(READER_WAIT_GRACE_MS);
  wait.connected();
  wait.connected();
  assert.deepEqual(changes, [true, false]);
});

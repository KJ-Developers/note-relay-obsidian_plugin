// What a host can truthfully say about a reader that is waiting to connect.
//
// The signalling room never tells a host that a reader is queued. Its only frames to a host are
// `ready` (both sockets are attached), the browser's relayed offer/ICE traffic, and `peer-left`;
// there is no acknowledgement frame and no `vaultOnline` flag in `cloud/src/signal-room.ts`. So a
// vault that is not hosting at all, or whose host socket is in retry backoff, produces nothing the
// plugin could observe — inventing a timer for that would raise "open your vault" on a machine
// where nobody is asking, which is worse than showing nothing.
//
// What the room does prove is that an authenticated browser is attached right now: `ready` reaches
// a host only when the room holds both sockets, and offers can only come from the browser role.
// A reader whose handshake then stalls — ICE never pairs, relay credentials are refused — sits
// waiting on us, and that is the state reported here. The grace period below is what keeps it
// honest: a normal direct or relay handshake finishes well inside it, so an ordinary read never
// raises the notice.
//
// British spelling is used throughout this file by project convention.

export const READER_WAIT_GRACE_MS = 8_000;

/** The wording the owner sees in the Notice. */
export const READER_WAIT_MESSAGE = 'A reader is waiting to connect.';

/** The same state in the status bar, where the existing line already does not capitalise. */
export const READER_WAIT_STATUS = 'a reader is waiting to connect';

/** Called only when the answer changes, so a caller can render it without de-duplicating itself. */
export type ReaderWaitChange = (waiting: boolean) => void;

export type ReaderWaitOptions = {
  graceMs?: number;
  onChange: ReaderWaitChange;
  /** Injected so a test can advance time instead of waiting eight seconds for every case. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * Tracks "a reader is attached but has not been served yet".
 *
 * Every method is idempotent and every transition is reported once, because the frames that drive
 * it arrive repeatedly: a stuck reader renegotiates, and the web viewer re-attaches with a fresh
 * grant while it waits.
 */
export class ReaderWaitMonitor {
  private handle: unknown = null;
  private waiting = false;
  private readonly graceMs: number;
  private readonly onChange: ReaderWaitChange;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: ReaderWaitOptions) {
    this.graceMs = options.graceMs ?? READER_WAIT_GRACE_MS;
    this.onChange = options.onChange;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** No timer, no claim: a monitor that never sees a frame never reports anything. */
  get isWaiting(): boolean { return this.waiting; }

  /**
   * A frame only an attached, authenticated browser can cause: `ready`, `offer` or `relay-offer`.
   *
   * Arrival alone claims nothing, because the host answers an offer within milliseconds and the
   * proof exchange follows. Only silence past the grace period means the reader is stuck.
   */
  readerArrived(): void {
    this.cancel();
    this.handle = this.setTimer(() => { this.handle = null; this.report(true); }, this.graceMs);
  }

  /** The reader finished its proof over the data channel: it is being served, not waiting. */
  connected(): void { this.cancel(); this.report(false); }

  /** The reader's signalling socket left; whether it comes back is its own business. */
  readerLeft(): void { this.cancel(); this.report(false); }

  /** Hosting stopped or the host's socket closed, so nothing can be observed any more. */
  disconnected(): void { this.cancel(); this.report(false); }

  private cancel(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }

  private report(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    this.onChange(waiting);
  }
}

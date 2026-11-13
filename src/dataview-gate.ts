import { clearTimer, setTimer } from './timers';

export class DataviewGate {
  private running = false;

  constructor(private readonly timeoutMs = 2000) {}

  run(start: () => Promise<string>): Promise<string> {
    if (this.running) return Promise.reject(new Error('Dataview is busy'));
    this.running = true;
    // Schedule the call so synchronous API throws follow the same cleanup path.
    const work = Promise.resolve().then(start);
    void work.then(
      () => { this.running = false; },
      () => { this.running = false; },
    );
    return new Promise<string>((resolve, reject) => {
      const timer = setTimer(() => reject(new Error('Dataview timed out')), this.timeoutMs);
      void work.then(
        value => { clearTimer(timer); resolve(value); },
        error => {
          clearTimer(timer);
          // A rejection reason that is not an Error loses its stack in every consumer, so it is
          // wrapped rather than passed through.
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

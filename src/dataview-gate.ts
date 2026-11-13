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
      const timer = setTimeout(() => reject(new Error('Dataview timed out')), this.timeoutMs);
      void work.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
}

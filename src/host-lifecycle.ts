// A host generation prevents work started under an old on/off cycle from
// returning after a stop and restart.
export class HostLifecycle {
  private generation = 0;
  private active = false;
  private controller = new AbortController();
  private session: string | null = null;

  get enabled(): boolean { return this.active; }
  get sessionId(): string | null { return this.session; }

  start(): void {
    if (this.active) return;
    this.generation++;
    this.controller = new AbortController();
    this.session = Array.from(crypto.getRandomValues(new Uint8Array(24)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    this.active = true;
  }

  stop(): void {
    if (!this.active) return;
    this.generation++;
    this.active = false;
    this.session = null;
    this.controller.abort();
  }

  currentRequest(): () => boolean {
    const requestGeneration = this.generation;
    return () => this.active && this.generation === requestGeneration;
  }

  currentSignal(): AbortSignal { return this.controller.signal; }
}

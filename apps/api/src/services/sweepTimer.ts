// SPDX-License-Identifier: BUSL-1.1

/**
 * The in-process timer a follow-up sweeps on: a sweep each tick, never
 * two at once, and one under way given a moment to finish when the app
 * stops. A sweep that loops checks `stopping` to let its work go.
 */
export class SweepTimer {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private halting = false;

  constructor(
    private readonly sweep: () => Promise<unknown>,
    private readonly opts: { tickMs: number; stopWaitMs: number; onError: (err: unknown) => void },
  ) {}

  /** The app is stopping. */
  get stopping(): boolean {
    return this.halting;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.opts.tickMs);
    this.timer.unref?.();
    this.kick();
  }

  /** Stop the timer, letting a sweep under way finish (briefly). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.halting = true;
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ticking ?? Promise.resolve(),
      new Promise((resolve) => {
        wait = setTimeout(resolve, this.opts.stopWaitMs);
      }),
    ]);
    clearTimeout(wait);
    this.halting = false;
  }

  /** Sweep now, while the timer runs, rather than at its next tick. */
  kick(): void {
    if (!this.timer || this.ticking) return;
    this.ticking = this.sweep()
      .then(
        () => undefined,
        (err: unknown) => this.opts.onError(err),
      )
      .finally(() => {
        this.ticking = null;
      });
  }
}

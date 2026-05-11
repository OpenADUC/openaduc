// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-(IP, username) login backoff. Process-memory only; in single-process
 * MVP this is sufficient. Multi-process deployments should swap this for a
 * Redis-backed implementation behind the same interface.
 *
 * Policy:
 *  - Track failures keyed by `${ip}|${usernameLowercase}`.
 *  - Failures within the observation window count up.
 *  - Once the threshold is reached, the key is "locked" — `check()` returns
 *    a remaining-ms until unlock and the route should 429.
 *  - On a successful auth the key is cleared.
 *
 * Defaults: 5 failures within 60 minutes locks for 15 minutes. Tunable via
 * the constructor args.
 */
export class LoginBackoffService {
  private readonly attempts = new Map<string, { failures: number[]; lockedUntil: number | null }>();
  private readonly sweepHandle: NodeJS.Timeout;

  constructor(
    private readonly threshold = 5,
    private readonly observationWindowMs = 60 * 60 * 1000,
    private readonly lockoutMs = 15 * 60 * 1000,
    sweepIntervalMs = 5 * 60 * 1000,
  ) {
    this.sweepHandle = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepHandle.unref?.();
  }

  /**
   * Returns `{ locked: true, retryAfterMs }` if the key is currently locked.
   * Otherwise `{ locked: false }`.
   */
  check(
    ip: string | null,
    username: string | null,
  ): { locked: false } | { locked: true; retryAfterMs: number } {
    const key = this.key(ip, username);
    const entry = this.attempts.get(key);
    if (!entry) return { locked: false };
    if (entry.lockedUntil !== null) {
      const remaining = entry.lockedUntil - Date.now();
      if (remaining > 0) return { locked: true, retryAfterMs: remaining };
      // Lock expired — reset.
      this.attempts.delete(key);
      return { locked: false };
    }
    return { locked: false };
  }

  recordFailure(
    ip: string | null,
    username: string | null,
  ): { locked: boolean; retryAfterMs?: number } {
    const key = this.key(ip, username);
    const now = Date.now();
    const entry = this.attempts.get(key) ?? { failures: [], lockedUntil: null };
    // Drop failures outside the observation window.
    entry.failures = entry.failures.filter((t) => now - t <= this.observationWindowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.threshold) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.attempts.set(key, entry);
    if (entry.lockedUntil !== null) {
      return { locked: true, retryAfterMs: entry.lockedUntil - now };
    }
    return { locked: false };
  }

  recordSuccess(ip: string | null, username: string | null): void {
    this.attempts.delete(this.key(ip, username));
  }

  size(): number {
    return this.attempts.size;
  }

  stop(): void {
    clearInterval(this.sweepHandle);
  }

  private key(ip: string | null, username: string | null): string {
    return `${ip ?? '?'}|${(username ?? '').toLowerCase()}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (entry.lockedUntil !== null && entry.lockedUntil <= now) {
        this.attempts.delete(key);
        continue;
      }
      const fresh = entry.failures.filter((t) => now - t <= this.observationWindowMs);
      if (fresh.length === 0 && entry.lockedUntil === null) {
        this.attempts.delete(key);
      } else {
        entry.failures = fresh;
      }
    }
  }
}

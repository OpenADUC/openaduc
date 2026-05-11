// SPDX-License-Identifier: BUSL-1.1
/**
 * Process-memory cache of step-up bind passwords keyed by elevated_session_id.
 *
 * The write-as-user model means each AD write must bind as the operator. To
 * avoid prompting for a password on every write during an elevated session,
 * we cache it here for the lifetime of the elevated session.
 *
 * Storage is in-memory only — never persisted, never logged. Entries are
 * evicted on:
 *   - explicit step-down (DELETE /api/auth/step-up)
 *   - admin session logout / revoke
 *   - elevated session TTL expiry (lazy on get + periodic sweep)
 *   - step-up rotation (which calls deleteMany on prior elevated session ids)
 *
 * Passwords are held as `Buffer`s and zeroed on eviction with `.fill(0)`. Node
 * doesn't guarantee that the OS will avoid swapping these pages, but this at
 * least removes the value from process memory once it's no longer needed
 * rather than leaving it for the GC to potentially copy around.
 *
 * Encryption-at-rest within the same process buys nothing (the key would live
 * next to the ciphertext). Defense-in-depth here means: keep the surface area
 * small, don't let it leak into logs, clear aggressively, zero on eviction.
 */
interface Entry {
  password: Buffer;
  expiresAt: number;
}

export class CredentialCacheService {
  private readonly entries = new Map<string, Entry>();
  private readonly sweepHandle: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    this.sweepHandle = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep the event loop alive just for this sweep.
    this.sweepHandle.unref?.();
  }

  set(elevatedSessionId: string, password: string, expiresAt: Date): void {
    // Replace any existing entry — wipe the old buffer first.
    const existing = this.entries.get(elevatedSessionId);
    if (existing) existing.password.fill(0);
    this.entries.set(elevatedSessionId, {
      password: Buffer.from(password, 'utf8'),
      expiresAt: expiresAt.getTime(),
    });
  }

  get(elevatedSessionId: string): string | null {
    const entry = this.entries.get(elevatedSessionId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.evict(elevatedSessionId, entry);
      return null;
    }
    // Decode each time — keeps the canonical store as a buffer we can wipe.
    return entry.password.toString('utf8');
  }

  delete(elevatedSessionId: string): void {
    const entry = this.entries.get(elevatedSessionId);
    if (entry) this.evict(elevatedSessionId, entry);
  }

  deleteMany(elevatedSessionIds: readonly string[]): void {
    for (const id of elevatedSessionIds) this.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  stop(): void {
    clearInterval(this.sweepHandle);
    // Wipe everything still in-flight on shutdown.
    for (const [id, entry] of this.entries) this.evict(id, entry);
  }

  private evict(id: string, entry: Entry): void {
    entry.password.fill(0);
    this.entries.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.evict(id, entry);
    }
  }
}

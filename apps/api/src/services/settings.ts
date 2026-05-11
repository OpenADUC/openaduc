// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

// Thin wrapper around app_settings. Phase 4 reads idle/absolute timeouts and
// step-up TTL; later phases will read more keys (sync cron, retention, etc.).
// Cached for a short window to avoid hitting the DB on every request.

const CACHE_TTL_MS = 5_000;

interface CachedValue {
  value: unknown;
  fetchedAt: number;
}

export class SettingsService {
  private readonly cache = new Map<string, CachedValue>();
  constructor(private readonly db: Kysely<DB>) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return (cached.value ?? fallback) as T;
    }
    const row = await this.db
      .selectFrom('app_settings')
      .select('value_json')
      .where('key', '=', key)
      .executeTakeFirst();
    const value = row?.value_json ?? null;
    this.cache.set(key, { value, fetchedAt: now });
    return (value ?? fallback) as T;
  }

  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}

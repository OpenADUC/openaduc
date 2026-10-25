// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryComputer, DirectoryProvider } from '../providers/types.js';
import { upsertComputer } from './computerCache.js';

/**
 * Read a computer from AD by objectGUID and put it in the cache, so lists
 * show it as it is now. Used before and after every computer write.
 */
export class ComputerLiveRefreshService {
  constructor(private readonly db: Kysely<DB>) {}

  async refresh(
    provider: DirectoryProvider,
    objectGuid: string,
  ): Promise<DirectoryComputer | null> {
    const live = await provider.getComputer({ kind: 'objectGuid', value: objectGuid });
    if (live) await upsertComputer(this.db, provider.id, live);
    return live;
  }
}

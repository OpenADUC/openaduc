// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

/** How current a cached list is: when its sync last succeeded. */
export const listFreshnessSchema = z.object({
  // Null when it has never synced successfully.
  lastSyncedAt: z.string().nullable(),
  // True when the last success is older than the sync cadence allows.
  stale: z.boolean(),
});
export type ListFreshness = z.infer<typeof listFreshnessSchema>;

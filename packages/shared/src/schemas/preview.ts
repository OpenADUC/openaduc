// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

/** How many users a preview lists in each of its lists; it counts them all. */
export const PREVIEW_LIST_LIMIT = 50;

export const previewUserSchema = z.object({ id: z.string(), name: z.string() });
export type PreviewUser = z.infer<typeof previewUserSchema>;

/** Some users, the first PREVIEW_LIST_LIMIT by name, and how many there are in all. */
export const previewUserListSchema = z.object({
  count: z.number().int(),
  users: z.array(previewUserSchema),
});
export type PreviewUserList = z.infer<typeof previewUserListSchema>;

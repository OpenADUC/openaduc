// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { groupPrivilegeSchema } from './userCreate.js';

/** What a bulk job does to each of its rows; also each row's audit action. */
export const BULK_JOB_ACTIONS = [
  'user.disable',
  'user.enable',
  'user.unlock',
  'user.group.add',
  'user.group.remove',
] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];

const BULK_JOB_PATHS: Record<BulkJobAction, string> = {
  'user.disable': '/users/bulk-disable',
  'user.enable': '/users/bulk-enable',
  'user.unlock': '/users/bulk-unlock',
  'user.group.add': '/users/bulk-add-to-groups',
  'user.group.remove': '/users/bulk-remove-from-groups',
};

/** The route, under /api, that starts a job of this action. */
export function bulkJobPath(action: BulkJobAction): string {
  return BULK_JOB_PATHS[action];
}

/**
 * `paused` waits for the operator: their elevated session ended
 * (`step_up_required`), the API stopped while it ran (`interrupted`), or
 * no domain controller answered (`directory_unavailable`). `finished` and
 * `cancelled` are final until the operator retries.
 */
export const BULK_JOB_STATUSES = ['queued', 'running', 'paused', 'finished', 'cancelled'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];

export const BULK_JOB_PAUSE_REASONS = [
  'step_up_required',
  'interrupted',
  'directory_unavailable',
] as const;
export type BulkJobPauseReason = (typeof BULK_JOB_PAUSE_REASONS)[number];

/**
 * `skipped`: the job was cancelled before the row ran, or the row needed
 * no change. `partial`: some of the row's changes were made and others
 * failed; a retry runs it again, as it does a failed row.
 */
export const BULK_JOB_ROW_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
] as const;
export type BulkJobRowStatus = (typeof BULK_JOB_ROW_STATUSES)[number];

export const MAX_BULK_JOB_ROWS = 10_000;

/** The most groups one membership job adds users to, or removes them from. */
export const MAX_BULK_GROUPS = 20;

const uniqueGuids = (max: number, what: string) =>
  z
    .array(z.guid())
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: `${what} must be unique`,
    });

/** Starting a job that acts on users by id. */
export const bulkJobCreateRequestSchema = z.object({
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
});
export type BulkJobCreateRequest = z.infer<typeof bulkJobCreateRequestSchema>;

export const BULK_MEMBERSHIP_OPS = ['add', 'remove'] as const;
export type BulkMembershipOp = (typeof BULK_MEMBERSHIP_OPS)[number];

const groupSelection = {
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
  groupIds: uniqueGuids(MAX_BULK_GROUPS, 'groupIds'),
};

/** What a membership job would change, asked before starting it. */
export const bulkGroupMembershipPreviewRequestSchema = z.object({
  op: z.enum(BULK_MEMBERSHIP_OPS),
  ...groupSelection,
});
export type BulkGroupMembershipPreviewRequest = z.infer<
  typeof bulkGroupMembershipPreviewRequestSchema
>;

/**
 * Adding users to groups, or removing them from groups: one row per user.
 * `previewToken` is the preview's, so the job runs on exactly the users
 * and groups the operator saw it for.
 */
export const bulkGroupMembershipRequestSchema = z.object({
  ...groupSelection,
  previewToken: z.string().min(1),
});
export type BulkGroupMembershipRequest = z.infer<typeof bulkGroupMembershipRequestSchema>;

/** How many users a preview lists in each group's lists; it counts them all. */
export const PREVIEW_LIST_LIMIT = 50;

export const bulkGroupPreviewUserSchema = z.object({ id: z.string(), name: z.string() });
export type BulkGroupPreviewUser = z.infer<typeof bulkGroupPreviewUserSchema>;

/** Some users, the first PREVIEW_LIST_LIMIT by name, and how many there are in all. */
const previewUsersSchema = z.object({
  count: z.number().int(),
  users: z.array(bulkGroupPreviewUserSchema),
});

/** One group in a membership job's preview, read from the cache. */
export const bulkGroupPreviewGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  distinguishedName: z.string(),
  /** Null for a group that grants no administrative rights. */
  privilege: groupPrivilegeSchema.nullable(),
  /** How many of the users the job would add to it, or remove from it. */
  changes: z.number().int(),
  /**
   * The users it would leave alone, already as the job would leave them:
   * members already (for an add, the group being their primary group
   * included), or not direct members (for a remove).
   */
  unchanged: previewUsersSchema,
  /**
   * Members only through a nested group, or for a remove through their
   * primary group: an add makes them direct members, and a remove leaves
   * them members.
   */
  indirect: previewUsersSchema,
});
export type BulkGroupPreviewGroup = z.infer<typeof bulkGroupPreviewGroupSchema>;

export const bulkGroupMembershipPreviewSchema = z.object({
  op: z.enum(BULK_MEMBERSHIP_OPS),
  groups: z.array(bulkGroupPreviewGroupSchema),
  /** Users asked for that the cache doesn't know; their rows would fail. */
  unknownCount: z.number().int(),
  /** Starting the job takes this back. */
  previewToken: z.string(),
});
export type BulkGroupMembershipPreview = z.infer<typeof bulkGroupMembershipPreviewSchema>;

export const bulkJobCountsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  succeeded: z.number().int(),
  partial: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkJobCounts = z.infer<typeof bulkJobCountsSchema>;

/** What a job acts with, besides its rows: the groups a membership job adds to or removes from. */
export const bulkJobSubjectSchema = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type BulkJobSubject = z.infer<typeof bulkJobSubjectSchema>;

export const bulkJobSchema = z.object({
  id: z.string(),
  action: z.enum(BULK_JOB_ACTIONS),
  /** Null for a job that acts on its rows alone, as disable does. */
  subject: bulkJobSubjectSchema.nullable(),
  status: z.enum(BULK_JOB_STATUSES),
  pauseReason: z.enum(BULK_JOB_PAUSE_REASONS).nullable(),
  actorDisplayName: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: bulkJobCountsSchema,
});
export type BulkJob = z.infer<typeof bulkJobSchema>;

export const bulkJobResponseSchema = z.object({ job: bulkJobSchema });
export const bulkJobListResponseSchema = z.object({ jobs: z.array(bulkJobSchema) });

export const bulkJobRowSchema = z.object({
  targetId: z.string(),
  targetName: z.string().nullable(),
  status: z.enum(BULK_JOB_ROW_STATUSES),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type BulkJobRow = z.infer<typeof bulkJobRowSchema>;

export const bulkJobRowsResponseSchema = z.object({ rows: z.array(bulkJobRowSchema) });

export const bulkJobRowsQuerySchema = z.object({
  status: z.enum(BULK_JOB_ROW_STATUSES).optional(),
});

/** A bulk job as the audit log shows it, on the `bulk.create` event that heads it. */
export const auditBulkSummarySchema = z.object({
  action: z.enum(BULK_JOB_ACTIONS),
  /** From its `bulk.create` event. */
  subject: bulkJobSubjectSchema.nullable(),
  /** Null once the job's record is gone; its audit events remain. */
  status: z.enum(BULK_JOB_STATUSES).nullable(),
  pauseReason: z.enum(BULK_JOB_PAUSE_REASONS).nullable(),
  /** Null once the job's record is gone. */
  counts: bulkJobCountsSchema.nullable(),
  /** How many rows it was started with, from its `bulk.create` event. */
  total: z.number().int(),
});
export type AuditBulkSummary = z.infer<typeof auditBulkSummarySchema>;

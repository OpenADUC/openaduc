// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import type { Capability } from '../capabilities.js';

/** What a bulk job does to each of its rows; also each row's audit action. */
export const BULK_JOB_ACTIONS = ['user.disable', 'user.enable', 'user.unlock'] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];

export const BULK_JOB_CAPABILITY: Record<BulkJobAction, Capability> = {
  'user.disable': 'write:user.enableDisable',
  'user.enable': 'write:user.enableDisable',
  'user.unlock': 'write:user.unlock',
};

/**
 * `paused` waits for the operator: their elevated session ended
 * (`step_up_required`), or the API stopped while it ran (`interrupted`).
 * `finished` and `cancelled` are final until the operator retries.
 */
export const BULK_JOB_STATUSES = ['queued', 'running', 'paused', 'finished', 'cancelled'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];

export const BULK_JOB_PAUSE_REASONS = ['step_up_required', 'interrupted'] as const;
export type BulkJobPauseReason = (typeof BULK_JOB_PAUSE_REASONS)[number];

/** `skipped`: the job was cancelled before the row ran. */
export const BULK_JOB_ROW_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type BulkJobRowStatus = (typeof BULK_JOB_ROW_STATUSES)[number];

export const MAX_BULK_JOB_ROWS = 10_000;

export const bulkJobCreateRequestSchema = z.object({
  ids: z
    .array(z.guid())
    .min(1)
    .max(MAX_BULK_JOB_ROWS)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'ids must be unique',
    }),
});
export type BulkJobCreateRequest = z.infer<typeof bulkJobCreateRequestSchema>;

export const bulkJobCountsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkJobCounts = z.infer<typeof bulkJobCountsSchema>;

export const bulkJobSchema = z.object({
  id: z.string(),
  action: z.enum(BULK_JOB_ACTIONS),
  status: z.enum(BULK_JOB_STATUSES),
  pauseReason: z.enum(BULK_JOB_PAUSE_REASONS).nullable(),
  actorDisplayName: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: bulkJobCountsSchema,
});
export type BulkJob = z.infer<typeof bulkJobSchema>;

export const bulkJobRowSchema = z.object({
  targetId: z.string(),
  targetName: z.string().nullable(),
  status: z.enum(BULK_JOB_ROW_STATUSES),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type BulkJobRow = z.infer<typeof bulkJobRowSchema>;

export const bulkJobRowsQuerySchema = z.object({
  status: z.enum(BULK_JOB_ROW_STATUSES).optional(),
});

/** A bulk job as the audit log shows it, on the `bulk.create` event that heads it. */
export const auditBulkSummarySchema = z.object({
  action: z.enum(BULK_JOB_ACTIONS).nullable(),
  /** Null once the job's record is gone; its audit events remain. */
  status: z.enum(BULK_JOB_STATUSES).nullable(),
  pauseReason: z.enum(BULK_JOB_PAUSE_REASONS).nullable(),
  total: z.number().int(),
  succeeded: z.number().int().nullable(),
  failed: z.number().int().nullable(),
});
export type AuditBulkSummary = z.infer<typeof auditBulkSummarySchema>;

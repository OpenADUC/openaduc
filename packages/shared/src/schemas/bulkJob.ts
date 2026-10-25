// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { directoryCountry } from '../country.js';
import type { Capability } from '../capabilities.js';
import { moveRequestSchema, ouRefSchema } from './ou.js';
import { accountExpiryRequestSchema, CONTROL_CHARS } from './user.js';
import { previewUserListSchema, previewUserSchema, PREVIEW_LIST_LIMIT } from './preview.js';
import { groupPrivilegeSchema } from './userCreate.js';

/** What a bulk job does to each of its rows; also each row's audit action. */
export const BULK_JOB_ACTIONS = [
  'user.disable',
  'user.enable',
  'user.unlock',
  'user.group.add',
  'user.group.remove',
  'user.update',
  'user.move',
  'user.accountExpiry.set',
  'user.passwordMustChange.set',
  'user.passwordNeverExpires.clear',
] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];

const BULK_JOB_PATHS: Record<BulkJobAction, string> = {
  'user.disable': '/users/bulk-disable',
  'user.enable': '/users/bulk-enable',
  'user.unlock': '/users/bulk-unlock',
  'user.group.add': '/users/bulk-add-to-groups',
  'user.group.remove': '/users/bulk-remove-from-groups',
  'user.update': '/users/bulk-update',
  'user.move': '/users/bulk-move',
  'user.accountExpiry.set': '/users/bulk-account-expiry',
  'user.passwordMustChange.set': '/users/bulk-require-password-change',
  'user.passwordNeverExpires.clear': '/users/bulk-clear-password-never-expires',
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
 * and groups the operator saw it for. Adding to a group AD protects
 * (adminCount, AdminSDHolder) takes `acknowledgeProtected`: the operator
 * ticked that these users gain admin rights.
 */
export const bulkGroupMembershipRequestSchema = z.object({
  ...groupSelection,
  previewToken: z.string().min(1),
  acknowledgeProtected: z.boolean().default(false),
});
export type BulkGroupMembershipRequest = z.input<typeof bulkGroupMembershipRequestSchema>;

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
  unchanged: previewUserListSchema,
  /**
   * Members only through a nested group, or for a remove through their
   * primary group: an add makes them direct members, and a remove leaves
   * them members.
   */
  indirect: previewUserListSchema,
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

/**
 * The attributes a bulk edit changes: ADUC's Organization tab and the
 * address. The country is c, co and countryCode, set together.
 */
export const BULK_ATTRIBUTE_FIELDS = [
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
  'manager',
  'description',
  'streetAddress',
  'postOfficeBox',
  'l',
  'st',
  'postalCode',
  'country',
] as const;
export type BulkAttributeField = (typeof BULK_ATTRIBUTE_FIELDS)[number];

const MAX_PO_BOXES = 10;

// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS_BUT_NEWLINES = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const value = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !(multiline ? CONTROL_CHARS_BUT_NEWLINES : CONTROL_CHARS).test(v), {
      message: 'cannot contain control characters',
    })
    // Null clears the attribute; left out, it's left alone.
    .nullable()
    .optional();

/** A bulk edit's changes, by field. AD's own upper bounds for each attribute. */
export const bulkAttributeChangesSchema = z
  .object({
    title: value(128),
    department: value(64),
    company: value(64),
    physicalDeliveryOfficeName: value(128),
    /** The manager's objectGUID. */
    manager: z.guid().nullable().optional(),
    description: value(1024),
    streetAddress: value(1024, true),
    /** Multi-valued: the values given replace all the user's. */
    postOfficeBox: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(40)
          .refine((v) => !CONTROL_CHARS.test(v), { message: 'cannot contain control characters' }),
      )
      .min(1)
      .max(MAX_PO_BOXES)
      .nullable()
      .optional(),
    l: value(128),
    st: value(128),
    postalCode: value(40),
    /** The two-letter code; its name and number are written with it. */
    country: z
      .string()
      .refine((c) => directoryCountry(c) !== null, { message: 'not a country code' })
      .transform((c) => c.toUpperCase())
      .nullable()
      .optional(),
  })
  .strict();
export type BulkAttributeChanges = z.infer<typeof bulkAttributeChangesSchema>;

/**
 * What a bulk edit would change, and each field's values across the users,
 * asked first. `offset` and `limit` page through the users it changes.
 */
export const bulkUserAttributesPreviewRequestSchema = z.object({
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
  /** Empty asks only for the current values. */
  changes: bulkAttributeChangesSchema.default({}),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(PREVIEW_LIST_LIMIT),
});
export type BulkUserAttributesPreviewRequest = z.input<
  typeof bulkUserAttributesPreviewRequestSchema
>;

/**
 * Editing users' attributes: one row per user. `previewToken` is the
 * preview's, so the job runs on exactly the users and changes previewed.
 */
export const bulkUserAttributesRequestSchema = z.object({
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
  changes: bulkAttributeChangesSchema.refine((c) => Object.keys(c).length > 0, {
    message: 'changes must name at least one field',
  }),
  previewToken: z.string().min(1),
});
export type BulkUserAttributesRequest = z.input<typeof bulkUserAttributesRequestSchema>;

/**
 * A field's value across the users: one they all share (null: all
 * empty), several, or not known yet for some of them (the cache hasn't
 * read it; the job reads each user live).
 */
export const bulkAttributeValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('same'), value: z.string().nullable() }),
  z.object({ kind: z.literal('multiple'), count: z.number().int() }),
  z.object({ kind: z.literal('unknown') }),
]);
export type BulkAttributeValue = z.infer<typeof bulkAttributeValueSchema>;

/** One field a user's row changes, as shown: a manager by name, a country by its name. */
export const bulkAttributeChangeSchema = z.object({
  field: z.enum(BULK_ATTRIBUTE_FIELDS),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type BulkAttributeChange = z.infer<typeof bulkAttributeChangeSchema>;

export const bulkAttributesPreviewUserSchema = previewUserSchema.extend({
  changes: z.array(bulkAttributeChangeSchema),
});
export type BulkAttributesPreviewUser = z.infer<typeof bulkAttributesPreviewUserSchema>;

/** A bulk edit's preview, read from the cache. Lists hold the first PREVIEW_LIST_LIMIT by name. */
export const bulkUserAttributesPreviewSchema = z.object({
  current: z.record(z.enum(BULK_ATTRIBUTE_FIELDS), bulkAttributeValueSchema),
  /** The users it would change, each with every field's before and after: the page asked for. */
  changed: z.object({
    count: z.number().int(),
    offset: z.number().int(),
    users: z.array(bulkAttributesPreviewUserSchema),
  }),
  /** The users already as asked, whose rows would be skipped. */
  unchanged: previewUserListSchema,
  /** Users it would change only in fields the cache hasn't read for them yet. */
  unread: previewUserListSchema,
  /** Users whose rows would be skipped, and why: one would become their own manager. */
  skipped: z.object({
    count: z.number().int(),
    users: z.array(previewUserSchema.extend({ reason: z.string() })),
  }),
  /** How many users each field asked for would change, and for how many it isn't known yet. */
  fields: z.array(
    z.object({
      field: z.enum(BULK_ATTRIBUTE_FIELDS),
      count: z.number().int(),
      unread: z.number().int(),
    }),
  ),
  /** Users asked for that the cache doesn't know; their rows would fail. */
  unknownCount: z.number().int(),
  /** Starting the job takes this back. */
  previewToken: z.string(),
});
export type BulkUserAttributesPreview = z.infer<typeof bulkUserAttributesPreviewSchema>;

/**
 * Changes to the accounts themselves, each with one target state for
 * every user: moving them to an OU, setting when their accounts expire
 * (null: never), making them change their password at next sign-in
 * (pwdLastSet 0), or clearing "password never expires".
 */
export const BULK_ACCOUNT_OPS = [
  'move',
  'accountExpiry',
  'mustChangePassword',
  'clearPasswordNeverExpires',
] as const;
export type BulkAccountOp = (typeof BULK_ACCOUNT_OPS)[number];

/** The job, and each row's audit action, for each account change. */
export const BULK_ACCOUNT_ACTIONS = {
  move: 'user.move',
  accountExpiry: 'user.accountExpiry.set',
  mustChangePassword: 'user.passwordMustChange.set',
  clearPasswordNeverExpires: 'user.passwordNeverExpires.clear',
} as const satisfies Record<BulkAccountOp, BulkJobAction>;

/**
 * The capability each account change takes. Expiry and clearing "password
 * never expires" write the Account Restrictions property set, as enabling
 * does; must-change is half of a password reset, and ADUC's delegation
 * wizard grants the two together.
 */
export const BULK_ACCOUNT_CAPABILITIES = {
  move: 'write:user.move',
  accountExpiry: 'write:user.enableDisable',
  mustChangePassword: 'write:user.resetPassword',
  clearPasswordNeverExpires: 'write:user.enableDisable',
} as const satisfies Record<BulkAccountOp, Capability>;

export const bulkAccountChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), targetOuDn: moveRequestSchema.shape.targetOuDn }).strict(),
  z
    .object({
      op: z.literal('accountExpiry'),
      expiresAt: accountExpiryRequestSchema.shape.expiresAt,
    })
    .strict(),
  z.object({ op: z.literal('mustChangePassword') }).strict(),
  z.object({ op: z.literal('clearPasswordNeverExpires') }).strict(),
]);
export type BulkAccountChange = z.infer<typeof bulkAccountChangeSchema>;

/**
 * What an account change would do to these users, asked first.
 * `offset` and `limit` page through the users it changes.
 */
export const bulkAccountPreviewRequestSchema = z.object({
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
  change: bulkAccountChangeSchema,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(PREVIEW_LIST_LIMIT),
});
export type BulkAccountPreviewRequest = z.input<typeof bulkAccountPreviewRequestSchema>;

/**
 * Making an account change: one row per user, at the route for its
 * op's action. `previewToken` is the preview's, so the job runs on
 * exactly the users and change previewed.
 */
export const bulkAccountRequestSchema = z.object({
  ids: uniqueGuids(MAX_BULK_JOB_ROWS, 'ids'),
  change: bulkAccountChangeSchema,
  previewToken: z.string().min(1),
});
export type BulkAccountRequest = z.input<typeof bulkAccountRequestSchema>;

/**
 * Users the preview points out, besides who it changes:
 * - `never_expires`: their password never expires, and while it doesn't,
 *   AD doesn't ask them to change it, must-change or not.
 * - `random_password`: created here with a random password nobody saw and
 *   not reset since; they sign in through Entra, where must-change stops
 *   a synced user signing in unless Connect Sync's force-change flag is on.
 * - `must_change`: already due to change their password, which AD holds
 *   back while it never expires; clearing that asks them at next sign-in.
 * - `name_taken`: their name (RDN) is taken in the OU a move goes to, by
 *   an object there or another user being moved; the move would fail.
 */
export const BULK_ACCOUNT_NOTES = [
  'never_expires',
  'random_password',
  'must_change',
  'name_taken',
] as const;
export type BulkAccountNote = (typeof BULK_ACCOUNT_NOTES)[number];

export const bulkAccountPreviewUserSchema = previewUserSchema.extend({
  /** What the user has now: the DN of the container they're in, or when their account expires (null: never). */
  from: z.string().nullable(),
});
export type BulkAccountPreviewUser = z.infer<typeof bulkAccountPreviewUserSchema>;

/** An account change's preview, read from the cache. Lists hold the first PREVIEW_LIST_LIMIT by name. */
export const bulkAccountPreviewSchema = z.object({
  op: z.enum(BULK_ACCOUNT_OPS),
  /** The users it would change: the page asked for. */
  changed: z.object({
    count: z.number().int(),
    offset: z.number().int(),
    users: z.array(bulkAccountPreviewUserSchema),
  }),
  /** The users already as asked, whose rows would be skipped. */
  unchanged: previewUserListSchema,
  /** Among the users it changes; only the notes that apply, each listing whom. */
  notes: z.array(previewUserListSchema.extend({ kind: z.enum(BULK_ACCOUNT_NOTES) })),
  /** The OU a move puts them in. */
  ou: ouRefSchema.nullable(),
  /** Users asked for that the cache doesn't know; their rows would fail. */
  unknownCount: z.number().int(),
  /** Starting the job takes this back. */
  previewToken: z.string(),
});
export type BulkAccountPreview = z.infer<typeof bulkAccountPreviewSchema>;

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

/**
 * What a job does besides naming its rows: the groups a membership job
 * adds to or removes from, the fields an edit sets (to the value shown,
 * a manager by name) or clears (null), the OU a move puts users in, or
 * when an expiry job makes accounts expire (null: never).
 */
export const bulkJobSubjectSchema = z.object({
  groups: z
    .array(z.object({ id: z.string(), name: z.string(), distinguishedName: z.string() }))
    .optional(),
  attributes: z
    .array(z.object({ field: z.enum(BULK_ATTRIBUTE_FIELDS), value: z.string().nullable() }))
    .optional(),
  ou: ouRefSchema.optional(),
  expiresAt: z.string().nullable().optional(),
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

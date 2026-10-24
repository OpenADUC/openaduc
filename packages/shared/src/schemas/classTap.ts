// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { TAP_LIFETIME_BOUNDS, tapPolicySchema } from './temporaryAccessPass.js';

// An import can issue each new hire a Temporary Access Pass that starts
// when their onboarding class does, often days later. OpenADUC creates
// each pass once the person is in Entra and keeps its value, encrypted,
// until the pass expires (docs/adr/0003-class-taps-are-stored-until-they-expire.md).
// The class roster lists the people with their passes.

/** A class's length unless the operator says otherwise, within the tenant's policy. */
export const CLASS_TAP_DEFAULT_LIFETIME_MINUTES = 240;

/**
 * How close to class someone still not in Entra becomes an alert on the
 * job: time enough to find out why Connect Sync hasn't brought them.
 */
export const CLASS_SYNC_ALERT_MINUTES = 120;

/** Whether the runtime knows this IANA time zone. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM' });

/**
 * When class starts: one time for the whole import, or each person's
 * start date (the import's Start date column) at one time of day, in the
 * operator's time zone.
 */
export const classStartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), startsAt: z.string().datetime({ offset: true }) }).strict(),
  z
    .object({
      kind: z.literal('startDate'),
      time: timeOfDay,
      timeZone: z.string().min(1).max(64).refine(isTimeZone, { message: 'is not a time zone' }),
    })
    .strict(),
]);
export type ClassStart = z.infer<typeof classStartSchema>;

/** Issue TAPs for class: what the import's Options step asks. */
export const classTapRequestSchema = z
  .object({
    start: classStartSchema,
    lifetimeMinutes: z.number().int().min(TAP_LIFETIME_BOUNDS.min).max(TAP_LIFETIME_BOUNDS.max),
    isUsableOnce: z.boolean(),
  })
  .strict();
export type ClassTapRequest = z.infer<typeof classTapRequestSchema>;

/** Whether an import can issue class passes here, and within what limits. */
export const classTapOptionsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), policy: tapPolicySchema }),
  /** The directory's feature is off, or the tenant has Temporary Access Pass turned off. */
  z.object({ status: z.literal('unavailable'), message: z.string() }),
]);
export type ClassTapOptions = z.infer<typeof classTapOptionsSchema>;

// ---- The class roster ---------------------------------------------------

export const CLASS_PASS_STATUSES = [
  /** The import hasn't created the account yet. */
  'awaitingAccount',
  /** The import didn't create the account. */
  'notCreated',
  /** Not in Microsoft Entra yet: Connect Sync hasn't brought them. */
  'waitingForSync',
  /** Making the pass went wrong in a way that may come right: it's tried again. */
  'retrying',
  /** Never issued one: they're, or may be, an administrator. */
  'refused',
  /** Entra or the tenant's policy wouldn't take the pass. */
  'failed',
  // Graph's methodUsabilityReason for the pass it holds.
  'notYetValid',
  'usable',
  'used',
  'expired',
  /** Entra holds another pass, or none: it was replaced or deleted outside the roster. */
  'replaced',
  /** Issued, but Graph couldn't be asked how it stands. */
  'issued',
] as const;
export type ClassPassStatus = (typeof CLASS_PASS_STATUSES)[number];

export const CLASS_PASS_STATUS_LABEL: Record<ClassPassStatus, string> = {
  awaitingAccount: 'Waiting for the account',
  notCreated: 'Account not created',
  waitingForSync: 'Waiting for sync',
  retrying: 'Trying again',
  refused: 'Not issued',
  failed: 'Not issued',
  notYetValid: 'Not yet valid',
  usable: 'Usable',
  used: 'Used',
  expired: 'Expired',
  replaced: 'Replaced in Entra',
  issued: 'Issued',
};

export const classRosterRowSchema = z.object({
  rowId: z.string(),
  /** Its row in the spreadsheet. */
  line: z.number().int(),
  displayName: z.string(),
  samAccountName: z.string(),
  personalEmail: z.string().nullable(),
  mobile: z.string().nullable(),
  /** The account's objectGUID, once the import has created it. */
  id: z.string().nullable(),
  status: z.enum(CLASS_PASS_STATUSES),
  /** Why it wasn't issued, or what went wrong last. */
  message: z.string().nullable(),
  /** When this person's pass starts, or would. */
  startsAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** OpenADUC holds the pass's value, so it can be revealed. */
  held: z.boolean(),
});
export type ClassRosterRow = z.infer<typeof classRosterRowSchema>;

export const classRosterSchema = z.object({
  job: z.object({
    id: z.string(),
    actorDisplayName: z.string().nullable(),
    createdAt: z.string(),
    /** The import is the reader's own, so its results page is theirs to open. */
    own: z.boolean(),
  }),
  class: classTapRequestSchema.extend({ updatedAt: z.string() }),
  /** When Connect Sync last ran a cycle, as Entra says; null when it can't be read. */
  lastSyncAt: z.string().nullable(),
  /** People still not in Entra this close to class: an alert on the job. */
  unsyncedAlert: z.object({ count: z.number().int(), startsAt: z.string() }).nullable(),
  /** Graph couldn't be asked how the passes stand. */
  statusError: z.string().nullable(),
  rows: z.array(classRosterRowSchema),
});
export type ClassRoster = z.infer<typeof classRosterSchema>;

/** A revealed pass. */
export const classPassRevealSchema = z.object({
  temporaryAccessPass: z.string(),
  startsAt: z.string(),
  expiresAt: z.string(),
  isUsableOnce: z.boolean(),
});
export type ClassPassReveal = z.infer<typeof classPassRevealSchema>;

/** What a reissue came to: the roster's row says the rest. */
export const classPassReissueSchema = z.object({
  outcome: z.enum(['issued', 'waiting', 'refused', 'failed']),
  message: z.string().nullable(),
});
export type ClassPassReissue = z.infer<typeof classPassReissueSchema>;

/** Reschedule class: every pass is created again for the new start. */
export const classRescheduleRequestSchema = z.object({ start: classStartSchema }).strict();
export type ClassRescheduleRequest = z.infer<typeof classRescheduleRequestSchema>;

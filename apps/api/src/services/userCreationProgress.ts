// SPDX-License-Identifier: BUSL-1.1
// How far a user create got, from its audit rows, and whether finishing
// it is still safe. The audit trail is the record: a create's row, and
// each finish's after it, say which steps are done and how the account
// was left.
import { USER_CREATE_STEPS, type UserCreateStep } from '@openaduc/shared';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { AccountFingerprint } from '../providers/types.js';

/** How long after a create its remaining steps can still be run. */
export const FINISH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UnfinishedCreate {
  /** The create's correlation id, which every finish of it records. */
  createCorrelationId: string;
  createdAt: Date;
  completed: UserCreateStep[];
  remaining: UserCreateStep[];
  /** The groups, by objectGUID, the groups step still has to add the account to. */
  groupsLeft: string[];
  /** The account as the latest step left it; null when it couldn't be read. */
  account: AccountFingerprint | null;
}

/** The latest create of an account, with the progress its latest finish recorded. */
export async function findUnfinishedCreate(
  db: Kysely<DB>,
  providerId: number,
  objectGuid: string,
): Promise<UnfinishedCreate | null> {
  const create = await db
    .selectFrom('audit_events')
    .select(['id', 'timestamp', 'correlation_id', 'after_json'])
    .where('provider_id', '=', providerId)
    .where('target_id', '=', objectGuid)
    .where('action', '=', 'user.create')
    .where(sql<boolean>`after_json ? 'remaining'`)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!create?.correlation_id) return null;
  const finish = await db
    .selectFrom('audit_events')
    .select('after_json')
    .where('provider_id', '=', providerId)
    .where('target_id', '=', objectGuid)
    .where('action', '=', 'user.create.finish')
    .where('id', '>', create.id)
    .where(sql<string>`metadata_json->>'createCorrelationId'`, '=', create.correlation_id)
    .where(sql<boolean>`after_json ? 'remaining'`)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  const after = finish?.after_json ?? create.after_json;
  const completed = stepsOf(after?.completed);
  const remaining = stepsOf(after?.remaining);
  if (!completed || !remaining) return null;
  return {
    createCorrelationId: create.correlation_id,
    createdAt: new Date(create.timestamp as unknown as string),
    completed,
    remaining,
    groupsLeft: Array.isArray(after?.groupsLeft)
      ? after.groupsLeft.filter((id): id is string => typeof id === 'string')
      : [],
    account: fingerprintOf(after?.account),
  };
}

/**
 * Why the steps a create left can't be run now, or null when they can.
 * They can only while the account is as the create left it: otherwise
 * finishing could reset and enable an account someone has since set up
 * by hand, or disabled as a leaver. uSNChanged moves with every change;
 * read from another domain controller it differs anyway, so then the
 * account must at least still have no password and no sign-in.
 */
export function finishRefusal(
  unfinished: UnfinishedCreate | null,
  live: AccountFingerprint & { enabled: boolean },
  now: Date,
): string | null {
  if (!unfinished || unfinished.remaining.length === 0) {
    return 'OpenADUC has no unfinished create of this account.';
  }
  if (now.getTime() - unfinished.createdAt.getTime() > FINISH_WINDOW_MS) {
    return 'OpenADUC created this account more than 24 hours ago, so it won’t finish it now. Reset its password and enable it instead.';
  }
  const was = unfinished.account;
  const changed = 'This account has changed since OpenADUC created it. Reset its password instead.';
  if (!was || was.objectGuid !== live.objectGuid || was.whenCreated !== live.whenCreated) {
    return changed;
  }
  if (live.enabled) return changed;
  if (was.usnChanged !== null && was.usnChanged === live.usnChanged) return null;
  const untouched =
    unfinished.remaining.includes('password') &&
    (live.pwdLastSet === null || live.pwdLastSet === '0') &&
    !live.lastLogonTimestamp;
  return untouched ? null : changed;
}

function stepsOf(v: unknown): UserCreateStep[] | null {
  return Array.isArray(v)
    ? v.filter((s): s is UserCreateStep => (USER_CREATE_STEPS as readonly unknown[]).includes(s))
    : null;
}

function fingerprintOf(v: unknown): AccountFingerprint | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const objectGuid = str('objectGuid');
  return objectGuid
    ? {
        objectGuid,
        whenCreated: str('whenCreated'),
        usnChanged: str('usnChanged'),
        pwdLastSet: str('pwdLastSet'),
        lastLogonTimestamp: str('lastLogonTimestamp'),
      }
    : null;
}

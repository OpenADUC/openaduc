// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  bulkAttributeChangesSchema,
  bulkGroupMembershipRequestSchema,
  bulkJobCreateRequestSchema,
  bulkUserAttributesRequestSchema,
  type BulkGroupMembershipRequest,
  type BulkJobAction,
  type BulkJobSubject,
  type BulkMembershipOp,
  type Capability,
} from '@openaduc/shared';
import type { DB } from '../../db/types.js';
import { isProtectedGroup, type RoleGroup } from '../../lib/groupPrivilege.js';
import { rawScalarValue } from '../../lib/rawAttributes.js';
import {
  DirectoryUnavailableError,
  type DirectoryProvider,
  type WriteContext,
} from '../../providers/types.js';
import type { AuditEventInput, AuditService } from '../audit.js';
import {
  askedSnapshot,
  attributesPreviewToken,
  changesSubject,
  fieldChanges,
  liveValues,
  patchFor,
  resolveChanges,
  rowSnapshots,
} from '../bulkAttributes.js';
import { findCachedGroupsById } from '../groupCache.js';
import {
  membershipRequirement,
  refreshMembershipCache,
  writeGroupMembership,
  type MembershipCacheDeps,
  type MembershipRequirement,
} from '../groupMembershipWrite.js';
import { previewToken } from '../groupMembershipPreview.js';
import { alreadyAsAsked, membershipState } from '../membershipState.js';
import { BulkJobRequestError } from './errors.js';
import { writeUserAttributes } from '../userAttributeWrite.js';
import {
  DISABLE_USER,
  ENABLE_USER,
  UNLOCK_USER,
  writeUserAccount,
  type AccountWrite,
} from '../userAccountWrite.js';

export interface BulkRowContext {
  db: Kysely<DB>;
  provider: DirectoryProvider;
  writeCtx: WriteContext;
  /** The row's audit fields, the bulk id included. */
  audit: Omit<AuditEventInput, 'action' | 'result'>;
  services: {
    audit: Pick<AuditService, 'recordEvent'>;
    userLiveRefresh: MembershipCacheDeps['userLiveRefresh'];
  };
}

export type BulkRowOutcome =
  | {
      ok: true;
      /** Nothing needed changing: the row is skipped rather than succeeded. */
      unchanged?: boolean;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      targetDn?: string;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage?: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      targetDn?: string;
      /** What the row says to the operator, in place of the message for its code. */
      message?: string;
      /** Some of the row's changes were made: the row is partial rather than failed. */
      partial?: boolean;
      /** The row's failure is in the audit log already. */
      audited: boolean;
    };

export interface BulkJobRowInput<Input> {
  targetId: string;
  /** Stored in the row's input_json, and handed back to `run`. */
  input: Input;
}

/**
 * One kind of bulk job. A new bulk action registers a handler: the
 * capability that starts it, how its request becomes rows, and how one row
 * runs. `run` makes the row's write, audits it as the single-object route
 * would (else returns `audited: false` and the job audits the failure),
 * and reports the before/after a revert would restore. Throwing
 * DirectoryUnavailableError pauses the job. `prepare`, for a job that acts
 * with more than its rows, checks the request against the directory
 * (throwing BulkJobRequestError when it can't start) and names what the
 * job acts with, so its progress and its audit entry can say it.
 */
export interface BulkJobHandler<Request = unknown, Input = unknown> {
  action: BulkJobAction;
  capability: Capability;
  request: z.ZodType<Request>;
  rows(request: Request): BulkJobRowInput<Input>[];
  prepare?(
    request: Request,
    lookup: { db: Kysely<DB>; directoryId: number },
  ): Promise<BulkJobSubject>;
  /** A capability the job's subject takes beyond `capability`, checked at start, continue and retry. */
  requires?(
    subject: BulkJobSubject | null,
    roleGroups: readonly RoleGroup[],
  ): MembershipRequirement | null;
  input: z.ZodType<Input>;
  run(
    row: {
      targetId: string;
      targetDn: string | null;
      input: Input;
      /** What an earlier run of this row recorded, for a retry to keep. */
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    },
    ctx: BulkRowContext,
  ): Promise<BulkRowOutcome>;
}

export type BulkJobHandlers = Record<BulkJobAction, BulkJobHandler>;

function userAccountHandler(
  account: AccountWrite & { action: BulkJobAction },
  capability: Capability,
): BulkJobHandler<z.infer<typeof bulkJobCreateRequestSchema>, null> {
  return {
    action: account.action,
    capability,
    request: bulkJobCreateRequestSchema,
    rows: ({ ids }) => ids.map((id) => ({ targetId: id.toLowerCase(), input: null })),
    input: z.null(),
    async run(row, ctx) {
      const written = await writeUserAccount(
        ctx.services,
        ctx.provider,
        account,
        row.targetId,
        ctx.writeCtx,
        ctx.audit,
      );
      if (!written) return { ok: false, errorCode: 'not_found', audited: false };
      const { result, user } = written;
      const fields = {
        before: result.before ?? null,
        after: result.after ?? null,
        targetDn: user.distinguishedName,
      };
      return result.ok
        ? { ok: true, ...fields }
        : {
            ok: false,
            errorCode: result.errorCode ?? 'directory_error',
            errorMessage: result.errorMessage ?? null,
            audited: true,
            ...fields,
          };
    },
  };
}

const groupIdsInputSchema = z.object({ groupIds: z.array(z.string()) });

/**
 * Add each user to the job's groups, or remove them, one row per user so
 * a row's result is that user's, naming any group that failed. A group the
 * user is already as asked in is left alone, so a retried row only makes
 * the changes still missing. Each change is audited as the single-member
 * route audits it.
 */
function groupMembershipHandler(
  op: BulkMembershipOp,
): BulkJobHandler<BulkGroupMembershipRequest, z.infer<typeof groupIdsInputSchema>> {
  const action = `user.group.${op}` as const;
  const notDone = op === 'add' ? 'Not added to' : 'Not removed from';
  return {
    action,
    capability: 'write:group.membership',
    request: bulkGroupMembershipRequestSchema,
    rows: ({ ids, groupIds }) => {
      const input = { groupIds: groupIds.map((id) => id.toLowerCase()) };
      return ids.map((id) => ({ targetId: id.toLowerCase(), input }));
    },
    input: groupIdsInputSchema,
    async prepare(
      { ids: userIds, groupIds, previewToken: token, acknowledgeProtected },
      { db, directoryId },
    ) {
      if (token !== previewToken(op, userIds, groupIds)) {
        throw new BulkJobRequestError(
          'preview_mismatch',
          'The users or groups aren’t the ones previewed. Preview the change again.',
        );
      }
      const ids = groupIds.map((id) => id.toLowerCase());
      const found = await findCachedGroupsById(db, directoryId, ids);
      const groups = ids.map((id) => {
        const group = found.get(id);
        if (!group) throw new BulkJobRequestError('group_not_found', 'group not found');
        return group;
      });
      const guarded = op === 'add' ? groups.find(isProtectedGroup) : undefined;
      if (guarded && !acknowledgeProtected) {
        throw new BulkJobRequestError(
          'protected_unacknowledged',
          `Adding users to ${guarded.name} gives them admin rights in AD. Confirm that they need them.`,
        );
      }
      return {
        groups: groups.map((g) => ({
          id: g.id.toLowerCase(),
          name: g.name,
          distinguishedName: g.distinguishedName,
        })),
      };
    },
    requires: (subject, roleGroups) => membershipRequirement(op, subject?.groups ?? [], roleGroups),
    async run(row, ctx) {
      const live = await ctx.services.userLiveRefresh.refresh(ctx.provider, row.targetId);
      if (!live) return { ok: false, errorCode: 'not_found', audited: false };
      const { user } = live;
      const groups = await findCachedGroupsById(ctx.db, ctx.provider.id, row.input.groupIds);
      const primaryGroupId = rawScalarValue(user.rawAttributes['primaryGroupID']);
      // A retry keeps what earlier runs changed, so the row still says what a revert restores.
      const changes = new Map(changedGroups(row.after).map((g) => [g.id, g]));
      const changedNow: string[] = [];
      const failures: { code: string; text: string }[] = [];

      for (const groupId of row.input.groupIds) {
        const group = groups.get(groupId);
        if (!group) {
          // Gone from the directory since the job started.
          await ctx.services.audit.recordEvent({
            ...ctx.audit,
            action,
            result: 'failure',
            errorCode: 'not_found',
            targetType: 'user',
            targetId: user.objectGuid,
            targetDn: user.distinguishedName,
            metadata: { groupId },
          });
          failures.push({
            code: 'not_found',
            text: `${notDone} a group that’s no longer in the directory.`,
          });
          continue;
        }
        // AD keeps the primary group out of member and refuses to add it
        // there, so an add records it as already done rather than failing.
        if (
          op === 'add' &&
          membershipState(group, { primaryGroupId, direct: false }) === 'primary'
        ) {
          const snapshot = {
            isMember: true,
            group: group.distinguishedName,
            member: user.distinguishedName,
            memberKind: 'user',
            primaryGroup: true,
          };
          await ctx.services.audit.recordEvent({
            ...ctx.audit,
            action,
            result: 'success',
            actorAuthMethod: 'ad-password',
            targetType: 'user',
            targetId: user.objectGuid,
            targetDn: user.distinguishedName,
            metadata: {
              groupId: group.id,
              groupDn: group.distinguishedName,
              groupName: group.name,
            },
            before: snapshot,
            after: snapshot,
          });
          continue;
        }
        // Whether the user is in the group is the directory's to say: the
        // provider checks member live, by the group's GUID, so a group
        // renamed or moved since the last sync is still found.
        let result;
        try {
          result = await writeGroupMembership(
            ctx.services.audit,
            ctx.provider,
            { kind: 'user', op, member: user, group },
            ctx.writeCtx,
            ctx.audit,
          );
        } catch (err) {
          if (!(err instanceof DirectoryUnavailableError)) throw err;
          failures.push({
            code: 'directory_unavailable',
            text: membershipFailure(op, group.name, 'directory_unavailable', null),
          });
          break;
        }
        if (!result.ok) {
          const code = result.errorCode ?? 'directory_error';
          failures.push({
            code,
            text: membershipFailure(op, group.name, code, result.errorMessage ?? null),
          });
          continue;
        }
        const state = membershipState(group, {
          primaryGroupId,
          direct: result.before?.['isMember'] === true,
        });
        if (alreadyAsAsked(op, state)) {
          continue;
        }
        changes.set(group.id, { id: group.id, name: group.name, isMember: op === 'add' });
        changedNow.push(group.name);
      }

      if (changedNow.length > 0) {
        await refreshMembershipCache(
          { db: ctx.db, userLiveRefresh: ctx.services.userLiveRefresh },
          ctx.provider,
          { kind: 'user', memberId: row.targetId },
        ).catch((err: unknown) => {
          // The writes are made and audited; the next sync brings the cache up to date.
          if (!(err instanceof DirectoryUnavailableError)) throw err;
        });
      }
      const merged = [...changes.values()];
      const fields = {
        before: merged.length
          ? { groups: merged.map((g) => ({ ...g, isMember: !g.isMember })) }
          : null,
        after: merged.length ? { groups: merged } : null,
        targetDn: user.distinguishedName,
      };
      if (failures.length === 0) return { ok: true, unchanged: merged.length === 0, ...fields };
      const done = merged.length
        ? `${op === 'add' ? 'Added to' : 'Removed from'} ${merged.map((g) => g.name).join(', ')}. `
        : '';
      return {
        ok: false,
        errorCode: failures[0]!.code,
        message: done + failures.map((f) => f.text).join(' '),
        partial: merged.length > 0,
        audited: true,
        ...fields,
      };
    },
  };
}

/** The groups a membership row's after-snapshot says it changed. */
function changedGroups(
  after: Record<string, unknown> | null,
): { id: string; name: string; isMember: boolean }[] {
  const groups = after?.['groups'];
  return Array.isArray(groups) ? (groups as { id: string; name: string; isMember: boolean }[]) : [];
}

/** Why one group's change in a membership row failed, naming the group. */
function membershipFailure(
  op: BulkMembershipOp,
  groupName: string,
  code: string,
  detail: string | null,
): string {
  const head = `${op === 'add' ? 'Not added to' : 'Not removed from'} ${groupName}`;
  const reason = detail ? `: ${detail}` : '.';
  switch (code) {
    case 'not_found':
      return `${head}: the group or the account is no longer in the directory.`;
    case 'conflict':
      return `${head}: the directory refused it as a conflict${reason}`;
    case 'permission_denied':
    case 'policy_violation':
      return `${head}: the directory refused the change${reason}`;
    case 'directory_unavailable':
      return `${head}: no domain controller could be reached.`;
    default:
      return `${head}: the change failed${reason}`;
  }
}

const attributesInputSchema = z.object({ changes: bulkAttributeChangesSchema });

/**
 * Edit each user's attributes, one row per user. A row reads the user
 * live and writes only the fields not already as asked, in one change
 * audited as the single-user edit is; a user with none to change is
 * skipped, and nothing is written for them.
 */
function userAttributesHandler(): BulkJobHandler<
  z.infer<typeof bulkUserAttributesRequestSchema>,
  z.infer<typeof attributesInputSchema>
> {
  return {
    action: 'user.update',
    capability: 'write:user.attributes',
    request: bulkUserAttributesRequestSchema,
    rows: ({ ids, changes }) =>
      ids.map((id) => ({ targetId: id.toLowerCase(), input: { changes } })),
    input: attributesInputSchema,
    async prepare({ ids, changes, previewToken: token }, { db, directoryId }) {
      if (token !== attributesPreviewToken(ids, changes)) {
        throw new BulkJobRequestError(
          'preview_mismatch',
          'The users or changes aren’t the ones previewed. Preview the change again.',
        );
      }
      return { attributes: changesSubject(await resolveChanges(db, directoryId, ids, changes)) };
    },
    async run(row, ctx) {
      const live = await ctx.services.userLiveRefresh.refresh(ctx.provider, row.targetId);
      if (!live) return { ok: false, errorCode: 'not_found', audited: false };
      const { user } = live;
      const targetDn = user.distinguishedName;
      let resolved;
      try {
        // The manager's DN as it is now, should it have moved since the job started.
        resolved = await resolveChanges(ctx.db, ctx.provider.id, [row.targetId], row.input.changes);
      } catch (err) {
        if (!(err instanceof BulkJobRequestError)) throw err;
        return {
          ok: false,
          errorCode: err.code,
          message:
            err.code === 'manager_not_found'
              ? 'The manager is no longer in the directory.'
              : err.message,
          audited: false,
          targetDn,
        };
      }
      const values = liveValues(user);
      const changes = fieldChanges(values, resolved);
      if (changes.length === 0) {
        // Audited as a no-op, before and after alike, so the job's events
        // account for every user it counted.
        const snapshot = askedSnapshot(values, resolved);
        await ctx.services.audit.recordEvent({
          ...ctx.audit,
          action: 'user.update',
          result: 'success',
          actorAuthMethod: 'ad-password',
          targetType: 'user',
          targetId: user.objectGuid,
          targetDn,
          metadata: { fields: [] },
          before: snapshot,
          after: snapshot,
        });
        return { ok: true, unchanged: true, before: row.before, after: row.after, targetDn };
      }
      const result = await writeUserAttributes(
        ctx.services,
        ctx.provider,
        user,
        patchFor(changes),
        ctx.writeCtx,
        ctx.audit,
      );
      if (!result.ok) {
        return {
          ok: false,
          errorCode: result.errorCode ?? 'directory_error',
          errorMessage: result.errorMessage ?? null,
          audited: true,
          targetDn,
        };
      }
      return { ok: true, ...rowSnapshots(changes), targetDn };
    },
  };
}

export const BULK_JOB_HANDLERS: BulkJobHandlers = {
  'user.disable': userAccountHandler(DISABLE_USER, 'write:user.enableDisable'),
  'user.enable': userAccountHandler(ENABLE_USER, 'write:user.enableDisable'),
  'user.unlock': userAccountHandler(UNLOCK_USER, 'write:user.unlock'),
  'user.group.add': groupMembershipHandler('add'),
  'user.group.remove': groupMembershipHandler('remove'),
  'user.update': userAttributesHandler(),
};

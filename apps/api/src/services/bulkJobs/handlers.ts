// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  bulkGroupMembershipRequestSchema,
  bulkJobCreateRequestSchema,
  type BulkGroupMembershipRequest,
  type BulkJobAction,
  type BulkJobSubject,
  type BulkMembershipOp,
  type Capability,
} from '@openaduc/shared';
import type { DB } from '../../db/types.js';
import { rawScalarValue } from '../../lib/rawAttributes.js';
import type { DirectoryProvider, WriteContext } from '../../providers/types.js';
import type { AuditEventInput, AuditService } from '../audit.js';
import { findCachedGroupsById } from '../groupCache.js';
import {
  refreshMembershipCache,
  writeGroupMembership,
  type MembershipCacheDeps,
} from '../groupMembershipWrite.js';
import { alreadyAsAsked, membershipState } from '../membershipState.js';
import { BulkJobRequestError } from './errors.js';
import { failureMessage } from './rowMessages.js';
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
 * DirectoryUnavailableError pauses the job. `subject`, for a job that acts
 * with more than its rows, names what with (throwing BulkJobRequestError
 * when it can't), so the job's progress and its audit entry can say it.
 */
export interface BulkJobHandler<Request = unknown, Input = unknown> {
  action: BulkJobAction;
  capability: Capability;
  request: z.ZodType<Request>;
  rows(request: Request): BulkJobRowInput<Input>[];
  subject?(
    request: Request,
    lookup: { db: Kysely<DB>; directoryId: number },
  ): Promise<BulkJobSubject>;
  input: z.ZodType<Input>;
  run(
    row: { targetId: string; targetDn: string | null; input: Input },
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
    async subject({ groupIds }, { db, directoryId }) {
      const ids = groupIds.map((id) => id.toLowerCase());
      const found = await findCachedGroupsById(db, directoryId, ids);
      return {
        groups: ids.map((id) => {
          const group = found.get(id);
          if (!group) throw new BulkJobRequestError('group_not_found', 'group not found');
          return { id, name: group.name };
        }),
      };
    },
    async run(row, ctx) {
      const live = await ctx.services.userLiveRefresh.refresh(ctx.provider, row.targetId);
      if (!live) return { ok: false, errorCode: 'not_found', audited: false };
      const { user } = live;
      const groups = await findCachedGroupsById(ctx.db, ctx.provider.id, row.input.groupIds);
      const memberOf = new Set(user.memberOfDns.map((dn) => dn.toLowerCase()));
      const primaryGroupId = rawScalarValue(user.rawAttributes['primaryGroupID']);
      const changed: { id: string; name: string }[] = [];
      const failed: string[] = [];
      let errorCode: string | null = null;

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
          errorCode ??= 'not_found';
          failed.push(`${notDone} a group that no longer exists.`);
          continue;
        }
        const state = membershipState(group, {
          primaryGroupId,
          direct: memberOf.has(group.distinguishedName.toLowerCase()),
        });
        if (alreadyAsAsked(op, state)) continue;
        const result = await writeGroupMembership(
          ctx.services.audit,
          ctx.provider,
          { kind: 'user', op, member: user, group },
          ctx.writeCtx,
          ctx.audit,
        );
        if (result.ok) {
          changed.push({ id: group.id, name: group.name });
        } else {
          const code = result.errorCode ?? 'directory_error';
          errorCode ??= code;
          failed.push(
            `${notDone} ${group.name}: ${failureMessage(code, result.errorMessage ?? null)}`,
          );
        }
      }

      if (changed.length > 0) {
        await refreshMembershipCache(
          { db: ctx.db, userLiveRefresh: ctx.services.userLiveRefresh },
          ctx.provider,
          { kind: 'user', memberId: row.targetId },
        );
      }
      const snapshot = (isMember: boolean) =>
        changed.length === 0 ? null : { groups: changed.map((g) => ({ ...g, isMember })) };
      const fields = {
        before: snapshot(op === 'remove'),
        after: snapshot(op === 'add'),
        targetDn: user.distinguishedName,
      };
      return errorCode === null
        ? { ok: true, ...fields }
        : { ok: false, errorCode, message: failed.join(' '), audited: true, ...fields };
    },
  };
}

export const BULK_JOB_HANDLERS: BulkJobHandlers = {
  'user.disable': userAccountHandler(DISABLE_USER, 'write:user.enableDisable'),
  'user.enable': userAccountHandler(ENABLE_USER, 'write:user.enableDisable'),
  'user.unlock': userAccountHandler(UNLOCK_USER, 'write:user.unlock'),
  'user.group.add': groupMembershipHandler('add'),
  'user.group.remove': groupMembershipHandler('remove'),
};

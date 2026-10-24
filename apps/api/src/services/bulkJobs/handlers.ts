// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import { bulkJobCreateRequestSchema, type BulkJobAction, type Capability } from '@openaduc/shared';
import type { DirectoryProvider, WriteContext } from '../../providers/types.js';
import type { AuditEventInput, AuditService } from '../audit.js';
import {
  DISABLE_USER,
  ENABLE_USER,
  UNLOCK_USER,
  writeUserAccount,
  type AccountWrite,
} from '../userAccountWrite.js';
import type { UserLiveRefreshService } from '../userLiveRefresh.js';

export interface BulkRowContext {
  provider: DirectoryProvider;
  writeCtx: WriteContext;
  /** The row's audit fields, the bulk id included. */
  audit: Omit<AuditEventInput, 'action' | 'result'>;
  services: {
    audit: Pick<AuditService, 'recordEvent'>;
    userLiveRefresh: Pick<UserLiveRefreshService, 'refresh'>;
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
 * DirectoryUnavailableError pauses the job.
 */
export interface BulkJobHandler<Request = unknown, Input = unknown> {
  action: BulkJobAction;
  capability: Capability;
  request: z.ZodType<Request>;
  rows(request: Request): BulkJobRowInput<Input>[];
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

export const BULK_JOB_HANDLERS: BulkJobHandlers = {
  'user.disable': userAccountHandler(DISABLE_USER, 'write:user.enableDisable'),
  'user.enable': userAccountHandler(ENABLE_USER, 'write:user.enableDisable'),
  'user.unlock': userAccountHandler(UNLOCK_USER, 'write:user.unlock'),
};

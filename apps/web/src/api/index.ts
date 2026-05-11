// SPDX-License-Identifier: BUSL-1.1
// Typed API client. All endpoints go through apiFetch so cookies and error
// shape are handled in one place.

import type {
  ComputerDetail,
  ComputerSearchQuery,
  ComputerSearchResponse,
  DeletedComputerDetail,
  DeletedComputerSearchQuery,
  DeletedComputerSearchResponse,
  DeletedUserDetail,
  DeletedUserSearchQuery,
  DeletedUserSearchResponse,
  DirectoryOu,
  GroupDetail,
  GroupPolicyDetail,
  GroupPolicyListResponse,
  GroupSearchQuery,
  GroupSearchResponse,
  LoginRequest,
  MeResponse,
  OuContentsResponse,
  OuCreateRequest,
  OuDeleteRequest,
  OuListResponse,
  OuUpdateRequest,
  ResetPasswordRequest,
  RestoreUserRequest,
  MfaRegistrationResponse,
  MfaRegistrationStatus,
  RestoreUserResponse,
  SignInEventApp,
  SignInEventDetail,
  SignInEventsResponse,
  StepUpRequest,
  UserDetail,
  UserMoveRequest,
  UserSearchQuery,
  UserSearchResponse,
  UserUpdateRequest,
} from '@openaduc/shared';
import { apiFetch } from './client.js';

export interface AuditEventRow {
  id: string;
  timestamp: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  actorAuthMethod: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  sessionId: string | null;
  correlationId: string | null;
  providerId: number | null;
  action: string;
  result: string;
  errorCode: string | null;
  targetType: string | null;
  targetId: string | null;
  targetDn: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

export interface DirectorySummary {
  id: number;
  name: string;
  displayName: string | null;
  type: string;
  domain: string;
  baseDn: string;
  ldapUrls: string[];
  tlsMode: string;
  tlsRejectUnauthorized: boolean | null;
  configured: boolean;
  // Sync service-account credentials — nullable when sync hasn't been
  // configured. Per-task scheduling state lives on the sync-tasks
  // endpoint, not here.
  syncBindUpn: string | null;
  hasSyncBindPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDirectorySummary {
  id: number;
  name: string;
  displayName: string | null;
  domain: string;
}

export interface DirectoryPatch {
  name?: string;
  displayName?: string | null;
  domain?: string;
  baseDn?: string;
  ldapUrls?: string[];
  tlsMode?: 'ldaps' | 'starttls' | 'plain';
  tlsRejectUnauthorized?: boolean;
  operationTimeoutMs?: number;
  // Sync service-account credentials. `syncBindUpn = null` clears the
  // UPN. `syncBindPassword = ""` clears the stored secret; non-empty
  // re-encrypts. Per-task cadences live on the sync-tasks endpoints.
  syncBindUpn?: string | null;
  syncBindPassword?: string;
}

export type SyncTaskKey =
  | 'users.locked'
  | 'users.delta'
  | 'users.full'
  | 'groups.delta'
  | 'groups.full'
  | 'computers.delta'
  | 'computers.full'
  | 'ous.full'
  | 'policies.full'
  | 'memberships.rebuild'
  | 'domain.policy'
  | 'tombstones'
  | 'entra.photos.refresh'
  | 'entra.signin.activity'
  | 'entra.signins.events'
  | 'entra.mfa.registration'
  | 'entra.password-expiry.notify';

export type EntraFeatureKey =
  | 'photos'
  | 'signInActivity'
  | 'signInEvents'
  | 'mfaRegistration'
  | 'teamsAdminWebhook'
  | 'passwordExpiryNotifications';

export interface EntraIntegrationSummary {
  id: number;
  providerId: number;
  tenantId: string;
  clientId: string;
  /** True when a client secret is stored. The secret itself never leaves the API. */
  hasClientSecret: boolean;
  enabled: boolean;
  features: Partial<Record<EntraFeatureKey, boolean>>;
  hasTeamsWebhookUrl: boolean;
  lastTestAt: string | null;
  lastTestStatus: 'success' | 'failure' | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntraIntegrationPut {
  tenantId: string;
  clientId: string;
  /** Send only when setting/rotating; omit to keep the existing secret. Empty string clears it. */
  clientSecret?: string;
  enabled?: boolean;
  features?: Partial<Record<EntraFeatureKey, boolean>>;
  /** Empty string clears the stored URL. */
  teamsWebhookUrl?: string;
}

export type ScheduleKind = 'interval' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';
/** '1'..'28' or 'last'. */
export type MonthlyDay = string;

export interface SyncTaskSummary {
  taskKey: SyncTaskKey;
  label: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** Effective cadence in minutes (only meaningful when scheduleKind = 'interval'). */
  intervalMinutes: number;
  /** Registry default cadence in minutes — UI uses this for the "Reset to defaults" button. */
  defaultIntervalMinutes: number;
  /** True when the row has its own override (only meaningful for 'interval'). */
  intervalIsOverride: boolean;
  anchorAt: string | null;
  /** Set only when scheduleKind = 'monthly'. */
  monthlyDay: MonthlyDay | null;
  /** Set only when scheduleKind = 'cron'. */
  cronExpr: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: 'running' | 'succeeded' | 'failed' | null;
  lastError: string | null;
  lastCursor: string | null;
  lastStats: Record<string, unknown> | null;
  consecutiveFailures: number;
  priority: number;
  nextDueAt: string | null;
}

export interface SyncTaskRun {
  id: number;
  status: 'running' | 'succeeded' | 'failed';
  // 'forced' = operator clicked Run now; 'cadence' = scheduled.
  trigger: 'forced' | 'cadence';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  stats: Record<string, unknown> | null;
}

export interface SyncTaskPatch {
  enabled?: boolean;
  scheduleKind?: ScheduleKind;
  intervalMinutes?: number | null;
  anchorAt?: string | null;
  monthlyDay?: MonthlyDay | null;
  cronExpr?: string | null;
}

export interface AppSettings {
  [key: string]: { value: unknown; description: string | null; updatedAt: string };
}

export interface SetupExistingDirectory {
  id: number;
  name: string;
  domain: string;
  baseDn: string;
  ldapUrls: string[];
  tlsMode: string;
  tlsRejectUnauthorized: boolean | null;
  syncBindUpn: string | null;
}

export interface SetupStatus {
  configured: boolean;
  hasServiceAccount: boolean;
  onboardingCompletedAt: string | null;
  existingDirectory: SetupExistingDirectory | null;
}

export interface SetupServiceAccountBody {
  username: string;
  password: string;
}

export interface SetupServiceAccountResult {
  ok: boolean;
  username: string;
  /** True when the service-account UPN matches the admin who set up the directory. */
  sameAsAdmin: boolean;
}

export interface SetupPolicyBody {
  passwordExpiringDays: number;
  staleLogonDays: number;
}

export interface InitialSyncTaskState {
  key: SyncTaskKey;
  label: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  stats: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface InitialSyncJob {
  directoryId: number;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  currentIdx: number;
  tasks: InitialSyncTaskState[];
  error: string | null;
}

/**
 * Body for POST /api/setup/initialize and POST /api/directories — same shape:
 * directory configuration plus admin credentials. The admin bind is the
 * test; on success the directory is persisted and (for /setup/initialize)
 * a session is opened for the admin.
 */
export interface DirectoryAdminBody {
  name?: string;
  displayName?: string;
  domain: string;
  baseDn: string;
  ldapUrls: string[];
  tlsMode: 'ldaps' | 'starttls' | 'plain';
  adminUsername: string;
  adminPassword: string;
  tlsRejectUnauthorized?: boolean;
  operationTimeoutMs?: number;
}

export interface IdentityCardData {
  objectGuid: string;
  sid: string | null;
  distinguishedName: string;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  email: string | null;
  title: string | null;
  department: string | null;
  enabled: boolean;
  locked: boolean;
  passwordLastSetAt: string | null;
  accountExpiresAt: string | null;
  lastLogonAt: string | null;
  createdAtSource: string | null;
  modifiedAtSource: string | null;
  memberOfDns: string[];
}

export const api = {
  auth: {
    login(body: LoginRequest): Promise<{ actor: MeResponse }> {
      return apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(body) });
    },
    logout(): Promise<{ ok: boolean }> {
      return apiFetch('/auth/logout', { method: 'POST' });
    },
    me(): Promise<{ actor: MeResponse }> {
      return apiFetch('/auth/me');
    },
    stepUp(
      body: StepUpRequest,
    ): Promise<{ elevated: { active: boolean; expiresAt: string | null } }> {
      return apiFetch('/auth/step-up', { method: 'POST', body: JSON.stringify(body) });
    },
    revokeStepUp(): Promise<{ ok: boolean }> {
      return apiFetch('/auth/step-up', { method: 'DELETE' });
    },
  },
  setup: {
    status(): Promise<SetupStatus> {
      return apiFetch('/setup/status');
    },
    initialize(
      body: DirectoryAdminBody,
    ): Promise<{ ok: boolean; directory: DirectorySummary; actor: MeResponse }> {
      return apiFetch('/setup/initialize', { method: 'POST', body: JSON.stringify(body) });
    },
    serviceAccount(body: SetupServiceAccountBody): Promise<SetupServiceAccountResult> {
      return apiFetch('/setup/service-account', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    policy(body: SetupPolicyBody): Promise<{ ok: boolean }> {
      return apiFetch('/setup/policy', { method: 'POST', body: JSON.stringify(body) });
    },
    runInitialSync(): Promise<{ job: InitialSyncJob }> {
      return apiFetch('/setup/run-initial-sync', { method: 'POST' });
    },
    initialSyncStatus(): Promise<{ job: InitialSyncJob | null }> {
      return apiFetch('/setup/initial-sync-status');
    },
    retryTask(): Promise<{ job: InitialSyncJob }> {
      return apiFetch('/setup/retry-task', { method: 'POST' });
    },
  },
  users: {
    search(query: Partial<UserSearchQuery> = {}): Promise<UserSearchResponse> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`/users${qs ? `?${qs}` : ''}`);
    },
    // Returns the absolute URL the browser should hit to download the
    // current filtered set as CSV. Caller passes the same shape they'd give
    // to `search()`; we strip pagination/sort params since the export is
    // always the full filtered result (capped server-side).
    exportCsvUrl(query: Partial<UserSearchQuery> = {}): string {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (k === 'page' || k === 'pageSize' || k === 'sort' || k === 'sortDir') continue;
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return `/api/users/export.csv${qs ? `?${qs}` : ''}`;
    },
    get(id: string): Promise<{ user: UserDetail }> {
      return apiFetch(`/users/${encodeURIComponent(id)}`);
    },
    unlock(id: string): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/unlock`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    update(
      id: string,
      body: UserUpdateRequest,
    ): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch(`/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    disable(id: string): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/disable`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    enable(id: string): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/enable`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    resetPassword(id: string, body: ResetPasswordRequest): Promise<{ ok: boolean }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/reset-password`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    addGroup(id: string, body: { groupId: string }): Promise<{ ok: boolean }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/groups`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    removeGroup(id: string, body: { groupId: string }): Promise<{ ok: boolean }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/groups`, {
        method: 'DELETE',
        body: JSON.stringify(body),
      });
    },
    move(
      id: string,
      body: UserMoveRequest,
    ): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch(`/users/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Activity feed for the user-detail Activity tab. Thin wrapper around
    // the audit-events endpoint scoped to this target user.
    activity(id: string, limit = 50): Promise<{ rows: AuditEventRow[]; total: number }> {
      const params = new URLSearchParams({
        targetType: 'user',
        targetId: id,
        pageSize: String(limit),
      });
      return apiFetch(`/audit-events?${params.toString()}`);
    },
  },
  deletedUsers: {
    search(query: Partial<DeletedUserSearchQuery> = {}): Promise<DeletedUserSearchResponse> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`/deleted-users${qs ? `?${qs}` : ''}`);
    },
    get(guid: string): Promise<{ user: DeletedUserDetail }> {
      return apiFetch(`/deleted-users/${encodeURIComponent(guid)}`);
    },
    restore(guid: string, body: RestoreUserRequest = {}): Promise<RestoreUserResponse> {
      return apiFetch(`/deleted-users/${encodeURIComponent(guid)}/restore`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  },
  groups: {
    search(query: Partial<GroupSearchQuery> = {}): Promise<GroupSearchResponse> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`/groups${qs ? `?${qs}` : ''}`);
    },
    get(id: string): Promise<{ group: GroupDetail }> {
      return apiFetch(`/groups/${encodeURIComponent(id)}`);
    },
  },
  groupPolicies: {
    list(): Promise<GroupPolicyListResponse> {
      return apiFetch('/policies/groups');
    },
    get(id: string): Promise<{ policy: GroupPolicyDetail }> {
      return apiFetch(`/policies/groups/${encodeURIComponent(id)}`);
    },
  },
  computers: {
    search(query: Partial<ComputerSearchQuery> = {}): Promise<ComputerSearchResponse> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`/computers${qs ? `?${qs}` : ''}`);
    },
    get(id: string): Promise<{ computer: ComputerDetail }> {
      return apiFetch(`/computers/${encodeURIComponent(id)}`);
    },
  },
  deletedComputers: {
    search(
      query: Partial<DeletedComputerSearchQuery> = {},
    ): Promise<DeletedComputerSearchResponse> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      return apiFetch(`/deleted-computers${qs ? `?${qs}` : ''}`);
    },
    get(guid: string): Promise<{ computer: DeletedComputerDetail }> {
      return apiFetch(`/deleted-computers/${encodeURIComponent(guid)}`);
    },
  },
  audit: {
    list(
      query: Record<string, string | number> = {},
    ): Promise<{ rows: AuditEventRow[]; total: number }> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) params.set(k, String(v));
      return apiFetch(`/audit-events${params.size ? `?${params}` : ''}`);
    },
  },
  directories: {
    public(): Promise<{ directories: PublicDirectorySummary[] }> {
      return apiFetch('/directories/public');
    },
    list(): Promise<{ directories: DirectorySummary[] }> {
      return apiFetch('/directories');
    },
    create(body: DirectoryAdminBody): Promise<{ directory: DirectorySummary }> {
      return apiFetch('/directories', { method: 'POST', body: JSON.stringify(body) });
    },
    update(id: number, body: DirectoryPatch): Promise<{ directory: DirectorySummary }> {
      return apiFetch(`/directories/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    sync(id: number): Promise<{ started: boolean; reason?: string }> {
      return apiFetch(`/directories/${id}/sync`, { method: 'POST' });
    },
    resetSync(id: number): Promise<{ ok: boolean }> {
      return apiFetch(`/directories/${id}/sync/reset`, { method: 'POST' });
    },
    syncTasks: {
      list(id: number): Promise<{ tasks: SyncTaskSummary[] }> {
        return apiFetch(`/directories/${id}/sync-tasks`);
      },
      update(
        id: number,
        key: SyncTaskKey,
        patch: SyncTaskPatch,
      ): Promise<{ task: SyncTaskSummary }> {
        return apiFetch(`/directories/${id}/sync-tasks/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      },
      run(id: number, key: SyncTaskKey): Promise<{ queued: boolean; reason?: string }> {
        return apiFetch(`/directories/${id}/sync-tasks/${encodeURIComponent(key)}/run`, {
          method: 'POST',
        });
      },
      reset(id: number, key: SyncTaskKey): Promise<{ ok: boolean }> {
        return apiFetch(`/directories/${id}/sync-tasks/${encodeURIComponent(key)}/reset`, {
          method: 'POST',
        });
      },
      history(
        id: number,
        key: SyncTaskKey,
        opts?: { limit?: number },
      ): Promise<{ runs: SyncTaskRun[] }> {
        const qs = opts?.limit ? `?limit=${opts.limit}` : '';
        return apiFetch(`/directories/${id}/sync-tasks/${encodeURIComponent(key)}/history${qs}`);
      },
      queue(id: number): Promise<{ inFlight: SyncTaskKey[]; queued: SyncTaskKey[] }> {
        return apiFetch(`/directories/${id}/sync-tasks/queue`);
      },
    },
    testSyncBind(
      id: number,
      body: { syncBindUpn: string; syncBindPassword?: string },
    ): Promise<{ ok: boolean; message: string; reason: string | null }> {
      return apiFetch(`/directories/${id}/test-sync-bind`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    policy(id: number): Promise<{ policy: import('@openaduc/shared').DirectoryPolicy }> {
      return apiFetch(`/directories/${id}/policy`);
    },
    entra: {
      get(id: number): Promise<{ integration: EntraIntegrationSummary | null }> {
        return apiFetch(`/directories/${id}/entra`);
      },
      put(
        id: number,
        body: EntraIntegrationPut,
      ): Promise<{ integration: EntraIntegrationSummary }> {
        return apiFetch(`/directories/${id}/entra`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      },
      remove(id: number): Promise<{ ok: boolean }> {
        return apiFetch(`/directories/${id}/entra`, { method: 'DELETE' });
      },
      test(
        id: number,
      ): Promise<{ ok: boolean; message: string; tenantDisplayName: string | null }> {
        return apiFetch(`/directories/${id}/entra/test`, { method: 'POST' });
      },
      /**
       * Returns the absolute URL the browser uses to render a user's
       * photo. The endpoint streams cached bytes (or fetches from Graph
       * lazily) and 404s when the user has no photo on file. Cookies
       * travel with the request automatically — no fetch() body needed.
       */
      photoUrl(directoryId: number, userId: string): string {
        return `/api/directories/${directoryId}/users/${encodeURIComponent(userId)}/photo`;
      },
      /**
       * Query the local entra_signin_events cache (delta-synced from
       * Graph by the entra.signins.events runner). All filters are
       * server-side; pagination is page/pageSize.
       */
      signInEvents(
        directoryId: number,
        opts: {
          userId?: string;
          appId?: string;
          status?: 'success' | 'failure' | 'all';
          fromIso?: string;
          toIso?: string;
          search?: string;
          page?: number;
          pageSize?: number;
        } = {},
      ): Promise<SignInEventsResponse> {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts)) {
          if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
        }
        const qs = params.toString();
        return apiFetch(`/directories/${directoryId}/signin-events${qs ? `?${qs}` : ''}`);
      },
      signInEventDetail(
        directoryId: number,
        eventId: string,
      ): Promise<{ event: SignInEventDetail }> {
        return apiFetch(`/directories/${directoryId}/signin-events/${encodeURIComponent(eventId)}`);
      },
      signInEventApps(directoryId: number): Promise<{ apps: SignInEventApp[] }> {
        return apiFetch(`/directories/${directoryId}/signin-events/apps`);
      },
      /**
       * Snapshot of MFA registration state across users. Backed by
       * user_entra_enrichment (delta-synced weekly by
       * entra.mfa.registration). Filter by status / specific method /
       * search.
       */
      mfaRegistration(
        directoryId: number,
        opts: {
          status?: MfaRegistrationStatus;
          method?: string;
          search?: string;
          page?: number;
          pageSize?: number;
        } = {},
      ): Promise<MfaRegistrationResponse> {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts)) {
          if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
        }
        const qs = params.toString();
        return apiFetch(`/directories/${directoryId}/mfa-registration${qs ? `?${qs}` : ''}`);
      },
      mfaRegistrationMethods(directoryId: number): Promise<{ methods: string[] }> {
        return apiFetch(`/directories/${directoryId}/mfa-registration/methods`);
      },
    },
  },
  // Surface a function that returns a download URL for the current filter
  // set. The browser handles the navigation directly so the filename and
  // streaming headers from the API do their job. Cookies travel with the
  // request automatically — no fetch() body to plumb.
  // (intentionally outside the directories block: it's a users-domain action
  // but lives on the same `api` object as the other user calls below.)
  ous: {
    list(): Promise<OuListResponse> {
      return apiFetch('/ous');
    },
    contents(dn: string): Promise<OuContentsResponse> {
      return apiFetch(`/ous/contents?dn=${encodeURIComponent(dn)}`);
    },
    create(body: OuCreateRequest): Promise<{ ok: boolean; ou: DirectoryOu }> {
      return apiFetch('/ous', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    update(body: OuUpdateRequest): Promise<{ ok: boolean; before: unknown; after: unknown }> {
      return apiFetch('/ous', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    delete(body: OuDeleteRequest): Promise<{ ok: boolean }> {
      return apiFetch('/ous', {
        method: 'DELETE',
        body: JSON.stringify(body),
      });
    },
  },
  settings: {
    list(): Promise<{ settings: AppSettings }> {
      return apiFetch('/settings');
    },
    update(body: Record<string, unknown>): Promise<{ ok: boolean; updated: string[] }> {
      return apiFetch('/settings', { method: 'PATCH', body: JSON.stringify(body) });
    },
  },
};

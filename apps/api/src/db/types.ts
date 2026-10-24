// SPDX-License-Identifier: BUSL-1.1
// Hand-maintained Kysely DB types that mirror the knex migrations in
// apps/api/migrations. When the schema stabilizes (post-MVP) we can switch to
// kysely-codegen; for now hand-rolled keeps PR review clear.

import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type {
  BulkJobKind,
  BulkJobSubject,
  BulkJobPauseReason,
  BulkJobRowStatus,
  BulkJobStatus,
  ClassStart,
  ImportField,
  ImportLicenseState,
  LicenseAssignmentError,
} from '@openaduc/shared';

// Common alias for `timestamp(useTz: true)`. Read as Date, write as ISO string or Date.
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;

export interface DirectoryProvidersTable {
  id: Generated<number>;
  name: string;
  display_name: string | null;
  type: string;
  domain_name: string;
  base_dn: string;
  ldap_urls: string[];
  tls_mode: ColumnType<string, string | undefined, string>;
  config_json: JSONColumnType<Record<string, unknown>>;
  configured: ColumnType<boolean, boolean | undefined, boolean>;
  // Sync service-account credentials — scoped exclusively to the
  // background scheduler. Per-session reads bind as the logged-in admin
  // and do not touch these. Per-task scheduling state lives in
  // directory_sync_tasks.
  sync_bind_upn: string | null;
  sync_bind_secret_encrypted: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface UserCacheRecordsTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  sid: string | null;
  distinguished_name: string;
  sam_account_name: string | null;
  user_principal_name: string | null;
  display_name: string | null;
  given_name: string | null;
  surname: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  department: string | null;
  manager_dn: string | null;
  office: string | null;
  /** False for a row cached before the office was: its office isn't known. */
  office_read: ColumnType<boolean, boolean | undefined, boolean>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  locked: ColumnType<boolean, boolean | undefined, boolean>;
  password_never_expires: ColumnType<boolean, boolean | undefined, boolean>;
  password_last_set_at: Timestamp | null;
  password_expires_at: Timestamp | null;
  password_must_change: ColumnType<boolean, boolean | undefined, boolean>;
  password_expiry_computed: ColumnType<boolean, boolean | undefined, boolean>;
  account_expires_at: Timestamp | null;
  last_logon_at: Timestamp | null;
  created_at_source: Timestamp | null;
  modified_at_source: Timestamp | null;
  synced_at: Timestamp | null;
  live_refreshed_at: Timestamp | null;
  stale_at: Timestamp | null;
  deleted_at: Timestamp | null;
  raw_attributes_json: JSONColumnType<Record<string, unknown>>;
}

export interface GroupCacheRecordsTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  sid: string | null;
  distinguished_name: string;
  sam_account_name: string | null;
  name: string | null;
  description: string | null;
  group_type: string | null;
  group_scope: string | null;
  synced_at: Timestamp | null;
  stale_at: Timestamp | null;
  deleted_at: Timestamp | null;
  raw_attributes_json: JSONColumnType<Record<string, unknown>>;
}

export interface ComputerCacheRecordsTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  sid: string | null;
  distinguished_name: string;
  sam_account_name: string | null;
  name: string | null;
  dns_host_name: string | null;
  operating_system: string | null;
  operating_system_version: string | null;
  description: string | null;
  managed_by_dn: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  last_logon_at: Timestamp | null;
  password_last_set_at: Timestamp | null;
  created_at_source: Timestamp | null;
  modified_at_source: Timestamp | null;
  synced_at: Timestamp | null;
  stale_at: Timestamp | null;
  deleted_at: Timestamp | null;
  raw_attributes_json: JSONColumnType<Record<string, unknown>>;
}

export interface DirectoryGroupPoliciesTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  gpo_guid: string;
  distinguished_name: string;
  display_name: string | null;
  file_sys_path: string | null;
  functionality_version: number | null;
  version_number_raw: number | null;
  user_version: number | null;
  computer_version: number | null;
  flags_raw: number | null;
  user_policy_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  computer_policy_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  wmi_filter_ref: string | null;
  computer_extension_guids: JSONColumnType<string[]>;
  user_extension_guids: JSONColumnType<string[]>;
  created_at_source: Timestamp | null;
  modified_at_source: Timestamp | null;
  synced_at: Timestamp | null;
  stale_at: Timestamp | null;
  deleted_at: Timestamp | null;
  raw_attributes_json: JSONColumnType<Record<string, unknown>>;
}

export interface DirectoryGroupPolicyLinksTable {
  id: Generated<number>;
  provider_id: number;
  scope_dn: string;
  gpo_dn: string;
  gpo_guid: string;
  link_order: number;
  flags_raw: number;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  enforced: ColumnType<boolean, boolean | undefined, boolean>;
  synced_at: Timestamp | null;
}

export interface DirectoryOusTable {
  id: Generated<number>;
  provider_id: number;
  distinguished_name: string;
  name: string;
  parent_dn: string | null;
  synced_at: Timestamp | null;
  stale_at: Timestamp | null;
  deleted_at: Timestamp | null;
  raw_attributes_json: JSONColumnType<Record<string, unknown>>;
}

export interface UserGroupMembershipsTable {
  provider_id: number;
  user_object_guid: string;
  group_object_guid: string;
  direct: ColumnType<boolean, boolean | undefined, boolean>;
  synced_at: TimestampDefault;
}

export interface GroupGroupMembershipsTable {
  provider_id: number;
  group_object_guid: string;
  member_group_object_guid: string;
  synced_at: TimestampDefault;
}

export interface AuditEventsTable {
  id: Generated<number>;
  timestamp: TimestampDefault;
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_auth_method: string | null;
  source_ip: string | null;
  user_agent: string | null;
  session_id: string | null;
  correlation_id: string | null;
  provider_id: number | null;
  target_type: string | null;
  target_id: string | null;
  target_dn: string | null;
  action: string;
  result: string;
  error_code: string | null;
  before_json: JSONColumnType<Record<string, unknown>> | null;
  after_json: JSONColumnType<Record<string, unknown>> | null;
  metadata_json: JSONColumnType<Record<string, unknown>>;
  // bigint, which pg returns as a string.
  bulk_job_id: ColumnType<string | null, string | null | undefined, never>;
}

// One run of a bulk action; see migrations/20261023000005_bulk_jobs.ts.
// Ids are bigints, which pg returns as strings.
export interface BulkJobsTable {
  id: Generated<string>;
  provider_id: number;
  action: BulkJobKind;
  status: BulkJobStatus;
  pause_reason: BulkJobPauseReason | null;
  run_token: string | null;
  subject_json: JSONColumnType<BulkJobSubject> | null;
  /** The job this one reverts; see migrations/20261024000004_bulk_job_reverts.ts. */
  reverts_job_id: ColumnType<string | null, string | null | undefined, never>;
  actor_user_id: string;
  actor_display_name: string | null;
  actor_username: string;
  admin_session_id: string;
  source_ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  created_at: TimestampDefault;
  heartbeat_at: TimestampDefault;
  finished_at: Timestamp | null;
  /** When an import's results CSV was downloaded, its passwords with it. */
  results_downloaded_at: Timestamp | null;
}

export interface BulkJobRowsTable {
  id: Generated<string>;
  job_id: string;
  ordinal: number;
  /** Null for an import's row until its account is created. */
  target_id: string | null;
  /** The row that must run first: the one creating this row's manager. */
  after_ordinal: number | null;
  target_dn: string | null;
  target_name: string | null;
  status: ColumnType<BulkJobRowStatus, BulkJobRowStatus | undefined, BulkJobRowStatus>;
  run_token: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  error_code: string | null;
  error_message: string | null;
  input_json: JSONColumnType<Record<string, unknown>> | null;
  before_json: JSONColumnType<Record<string, unknown>> | null;
  after_json: JSONColumnType<Record<string, unknown>> | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface AdminSessionsTable {
  id: Generated<string>;
  token_hash: string;
  // The domain this session is scoped to. Every read/write performed during
  // the session uses this directory. Switching domains = log out, log in.
  directory_id: number;
  actor_user_id: string;
  actor_display_name: string | null;
  actor_username: string | null;
  actor_email: string | null;
  actor_dn: string | null;
  capabilities_json: JSONColumnType<string[]>;
  source_ip: string | null;
  user_agent: string | null;
  created_at: TimestampDefault;
  last_seen_at: TimestampDefault;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface ElevatedSessionsTable {
  id: Generated<string>;
  admin_session_id: string;
  actor_user_id: string;
  auth_method: ColumnType<string, string | undefined, string>;
  capabilities_json: JSONColumnType<string[]>;
  created_at: TimestampDefault;
  idle_expires_at: Timestamp;
  // The absolute end.
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

// Per-directory sync task scheduling. Rows are seeded lazily by the
// scheduler from the in-code task registry; missing rows imply the task
// has never been seen for that directory yet.
export interface DirectorySyncTasksTable {
  id: Generated<number>;
  provider_id: number;
  task_key: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  // null = inherit registry default cadence (only meaningful when
  // schedule_kind = 'interval').
  interval_minutes: number | null;
  // 'interval' (default) | 'daily' | 'weekly' | 'monthly'. Decides how
  // anchor_at and interval_minutes / monthly_day are interpreted.
  schedule_kind: ColumnType<string, string | undefined, string>;
  // For schedule_kind='monthly': '1'..'28' or 'last'. Null otherwise.
  monthly_day: string | null;
  // For schedule_kind='cron': a 5-field cron expression. Null otherwise.
  cron_expr: string | null;
  // null = no clock anchor; due-ness uses elapsed-since-last-run.
  // For 'daily'/'weekly'/'monthly' the time-of-day (and weekday for
  // weekly) is extracted from this timestamp.
  anchor_at: Timestamp | null;
  last_started_at: Timestamp | null;
  last_finished_at: Timestamp | null;
  last_status: string | null;
  last_error: string | null;
  // Opaque to the scheduler. *.delta runners write the modifiedSince
  // timestamp here; future DirSync runners would write a cookie.
  last_cursor: string | null;
  last_stats_json: JSONColumnType<Record<string, unknown>> | null;
  consecutive_failures: ColumnType<number, number | undefined, number>;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

// One row per individual task run. directory_sync_tasks keeps only the
// latest result; this table keeps the full history so the operator can
// see what's been happening over time.
export interface DirectorySyncTaskRunsTable {
  id: Generated<number>;
  provider_id: number;
  task_key: string;
  status: string; // 'running' | 'succeeded' | 'failed'
  started_at: Timestamp;
  finished_at: Timestamp | null;
  duration_ms: number | null;
  error: string | null;
  stats_json: JSONColumnType<Record<string, unknown>> | null;
  trigger: ColumnType<string, string | undefined, string>; // 'forced' | 'cadence'
}

// app_settings.value_json holds arbitrary JSON (string, number, bool, object, etc.).
// JSONColumnType requires `object | null`, so we use a raw ColumnType — the pg
// driver returns parsed JSON already; writes are stringified manually by the
// settings service.
export interface AppSettingsTable {
  key: string;
  value_json: ColumnType<unknown, string | null, string | null>;
  description: string | null;
  updated_by_actor_id: string | null;
  updated_at: TimestampDefault;
}

// Per-directory Microsoft Entra (Graph) integration. 1:1 with
// directory_providers. Secrets (client_secret, teams_webhook_url) are
// AES-256-GCM enveloped via lib/encryption.ts.
export interface DirectoryEntraIntegrationsTable {
  id: Generated<number>;
  provider_id: number;
  tenant_id: string; // GUID
  client_id: string;
  client_secret_encrypted: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  // { photos?: bool, signInActivity?: bool, teamsAdminWebhook?: bool,
  //   passwordExpiryNotifications?: bool }
  features_json: JSONColumnType<Record<string, unknown>>;
  teams_webhook_url_encrypted: string | null;
  last_test_at: Timestamp | null;
  last_test_status: string | null;
  last_test_error: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

// Per-user photo bytes pulled from Microsoft Graph. Keyed by AD object_guid.
export interface UserPhotosTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  content_type: string;
  etag: string | null;
  bytes: Buffer;
  fetched_at: TimestampDefault;
  absent: ColumnType<boolean, boolean | undefined, boolean>;
}

// Per-user Graph enrichment (sign-in activity, MFA registration, Entra
// IDs). Keyed by AD object_guid; deliberately separate from user_photos
// to avoid pulling BYTEA into every list query. MFA + sign-in activity
// share the row but track their fetched_at separately so a failing
// report endpoint doesn't poison the staler-of-the-two display.
export interface UserEntraEnrichmentTable {
  id: Generated<number>;
  provider_id: number;
  object_guid: string;
  last_sign_in_at: Timestamp | null;
  last_non_interactive_sign_in_at: Timestamp | null;
  entra_object_id: string | null;
  user_principal_name: string | null;
  last_status: string | null;
  fetched_at: TimestampDefault;
  is_mfa_registered: boolean | null;
  is_mfa_capable: boolean | null;
  is_passwordless_capable: boolean | null;
  /** Array of method strings from Graph; stored as a generic JSON value. */
  mfa_methods_json: JSONColumnType<string[]> | null;
  default_mfa_method: string | null;
  mfa_fetched_at: Timestamp | null;
  mfa_last_status: string | null;
}

// Local cache of Microsoft Entra sign-in events. Populated by the
// entra.signins.events runner (delta sync from Graph /auditLogs/signIns)
// and queried by the user-detail Sign-ins tab + the global Audit
// Sign-ins tab.
export interface EntraSignInEventsTable {
  id: Generated<number>;
  provider_id: number;
  entra_event_id: string;
  user_object_guid: string | null;
  entra_user_id: string | null;
  user_principal_name: string | null;
  user_display_name: string | null;
  app_id: string | null;
  app_display_name: string | null;
  ip_address: string | null;
  client_app_used: string | null;
  conditional_access_status: string | null;
  is_interactive: boolean | null;
  status_error_code: number | null;
  status_failure_reason: string | null;
  risk_state: string | null;
  risk_level: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  device_os: string | null;
  device_browser: string | null;
  device_trust_type: string | null;
  auth_methods: JSONColumnType<string[]>;
  created_date_time: Timestamp;
  fetched_at: TimestampDefault;
  detail_json: JSONColumnType<Record<string, unknown>>;
}

export interface ImportPlacementRulesTable {
  id: Generated<string>;
  provider_id: number;
  grouping_column: ImportField;
  value_key: string;
  value: string;
  ou_dn: string;
  group_ids: JSONColumnType<string[]>;
  updated_by: string | null;
  updated_at: TimestampDefault;
}

/** A license an Entra group grants. */
export interface EntraGroupSku {
  skuId: string;
  skuPartNumber: string | null;
  disabledPlanCount: number;
}

/** See migrations/20261026000001_entra_group_licenses.ts. */
export interface EntraGroupLicensesTable {
  provider_id: number;
  entra_group_id: string;
  display_name: string | null;
  on_premises_sid: string | null;
  skus: JSONColumnType<EntraGroupSku[]>;
}

/** See migrations/20261025000001_bulk_job_creates.ts. */
export interface ImportPasswordsTable {
  id: Generated<string>;
  job_id: string;
  /** Null for the one password every row of the job gets. */
  row_id: string | null;
  password_enc: string;
  expires_at: Timestamp;
  created_at: TimestampDefault;
}

/** See migrations/20261027000001_class_passes.ts. */
export interface ImportClassesTable {
  job_id: string;
  start: JSONColumnType<ClassStart>;
  lifetime_minutes: number;
  is_usable_once: boolean;
  /** Who the class's passes are made on behalf of: the import's operator, or who took it over. */
  authoriser_user_id: string;
  authoriser_display_name: string | null;
  /** When the follow-up found the authoriser could no longer issue passes; null while they can. */
  authority_lapsed_at: Timestamp | null;
  authority_message: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export type ClassPassState = 'waiting' | 'issued' | 'refused' | 'failed';

export interface ClassPassesTable {
  row_id: string;
  job_id: string;
  status: ColumnType<ClassPassState, ClassPassState | undefined, ClassPassState>;
  class_starts_at: Timestamp | null;
  entra_user_id: string | null;
  entra_method_id: string | null;
  pass_enc: string | null;
  pass_starts_at: Timestamp | null;
  expires_at: Timestamp | null;
  error_code: string | null;
  message: string | null;
  tenant_last_sync_at: Timestamp | null;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: TimestampDefault;
  claim_token: string | null;
  /** An Entra pass a reschedule or reissue replaced, to delete before the new one is made. */
  stale_method_id: string | null;
  updated_at: TimestampDefault;
}

export type ImportLicenseCheckState = 'waiting' | 'settled' | 'stopped';

/**
 * What a check last waited on, or why it stopped. See
 * migrations/20261028000002_import_license_check_stops.ts.
 */
export type ImportLicenseCheckCode =
  | 'unsynced'
  | 'throttled'
  | 'graph_refused'
  | 'graph_unavailable'
  | 'directory_unavailable'
  | 'internal_error'
  | 'licenses_off'
  | 'not_in_groups'
  | 'not_created'
  | 'sync_timeout'
  | 'settle_timeout';

/** A licensed group an import row joins, as the license cache had it. */
export interface ExpectedLicenseGroup {
  groupId: string;
  entraGroupId: string;
  name: string;
  skus: EntraGroupSku[];
}

/** One license a row's groups grant, as Entra last said. */
export interface CheckedLicense {
  skuId: string;
  skuPartNumber: string | null;
  group: string;
  state: ImportLicenseState;
  error: LicenseAssignmentError | null;
}

/** See migrations/20261028000001_import_license_checks.ts. */
export interface ImportLicenseChecksTable {
  row_id: string;
  job_id: string;
  expected: JSONColumnType<ExpectedLicenseGroup[]>;
  status: ColumnType<
    ImportLicenseCheckState,
    ImportLicenseCheckState | undefined,
    ImportLicenseCheckState
  >;
  entra_user_id: string | null;
  licenses: JSONColumnType<CheckedLicense[] | null, string | null, string | null>;
  error_code: ImportLicenseCheckCode | null;
  message: string | null;
  started_at: Timestamp | null;
  synced_at: Timestamp | null;
  checked_at: Timestamp | null;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: TimestampDefault;
  claim_token: string | null;
  updated_at: TimestampDefault;
}

export interface DB {
  directory_providers: DirectoryProvidersTable;
  directory_entra_integrations: DirectoryEntraIntegrationsTable;
  entra_signin_events: EntraSignInEventsTable;
  user_cache_records: UserCacheRecordsTable;
  user_photos: UserPhotosTable;
  user_entra_enrichment: UserEntraEnrichmentTable;
  group_cache_records: GroupCacheRecordsTable;
  computer_cache_records: ComputerCacheRecordsTable;
  directory_ous: DirectoryOusTable;
  directory_group_policies: DirectoryGroupPoliciesTable;
  directory_group_policy_links: DirectoryGroupPolicyLinksTable;
  user_group_memberships: UserGroupMembershipsTable;
  group_group_memberships: GroupGroupMembershipsTable;
  audit_events: AuditEventsTable;
  bulk_jobs: BulkJobsTable;
  bulk_job_rows: BulkJobRowsTable;
  import_placement_rules: ImportPlacementRulesTable;
  import_passwords: ImportPasswordsTable;
  import_classes: ImportClassesTable;
  class_passes: ClassPassesTable;
  import_license_checks: ImportLicenseChecksTable;
  entra_group_licenses: EntraGroupLicensesTable;
  admin_sessions: AdminSessionsTable;
  elevated_sessions: ElevatedSessionsTable;
  app_settings: AppSettingsTable;
  directory_sync_tasks: DirectorySyncTasksTable;
  directory_sync_task_runs: DirectorySyncTaskRunsTable;
}

// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Local cache of Microsoft Entra sign-in events. Populated by a delta
// sync runner that pulls /auditLogs/signIns from Graph at a regular
// cadence; the UI queries this table rather than proxying to Graph
// per-page-load. Trade-offs accepted:
//
//   - Storage: events accumulate forever in v1; retention is a separate
//     task to add later if size becomes an issue. Entra itself keeps
//     30d (P1) / 90d (P2), so we have to retain past those windows
//     ourselves anyway if longer history is wanted.
//   - Freshness: events visible after the next runner tick (15-30min).
//     Better than the live-proxy approach when filtering by user,
//     because Graph's $filter on userPrincipalName is case-sensitive
//     against our stored UPN — local matching by user_object_guid is
//     reliable.
//
// We promote the most-filtered fields into typed columns (app, IP,
// user, status, createdDateTime) and keep everything else in
// detail_json for the row-detail modal — so the UI can filter without
// a JSONB scan and the schema doesn't have to grow with every Graph
// field we end up exposing.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('entra_signin_events', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    // Graph's event id; unique per provider. Used for ON CONFLICT
    // dedupe so re-pulling an overlap window is idempotent.
    t.text('entra_event_id').notNullable();
    // Resolved AD objectGuid for the signing user. NULL when the user
    // is cloud-only (no on-prem twin) or when the runner couldn't
    // match. Filtering by user uses this column.
    t.uuid('user_object_guid');
    t.text('entra_user_id');
    t.text('user_principal_name');
    t.text('user_display_name');
    // App that was signed into.
    t.text('app_id');
    t.text('app_display_name');
    // Network / client.
    t.text('ip_address');
    t.text('client_app_used'); // 'Browser' | 'Mobile Apps and Desktop clients' | …
    t.text('conditional_access_status'); // 'success' | 'failure' | 'notApplied' | …
    t.boolean('is_interactive');
    // Status. error_code = 0 = success; non-zero = failure.
    t.integer('status_error_code');
    t.text('status_failure_reason');
    t.text('risk_state'); // 'none' | 'atRisk' | …
    t.text('risk_level'); // 'low' | 'medium' | 'high' | 'none' | 'hidden'
    // Location.
    t.text('location_city');
    t.text('location_state');
    t.text('location_country');
    // Device.
    t.text('device_os');
    t.text('device_browser');
    t.text('device_trust_type');
    // Authentication methods that succeeded during this sign-in.
    t.jsonb('auth_methods').notNullable().defaultTo('[]');
    // When the sign-in happened (Graph createdDateTime).
    t.timestamp('created_date_time', { useTz: true }).notNullable();
    // When we pulled it.
    t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Catch-all for fields we don't promote — surfaced in the modal
    // detail view (additionalDetails, conditionalAccessPolicies, raw
    // authenticationDetails, etc.). Bounded by Graph's response size.
    t.jsonb('detail_json').notNullable().defaultTo('{}');

    t.unique(['provider_id', 'entra_event_id']);
    // Per-user time-ordered queries (user-detail Sign-ins tab).
    t.index(
      ['provider_id', 'user_object_guid', 'created_date_time'],
      'entra_signin_events_user_time_idx',
    );
    // Tenant-wide time-ordered queries (audit Sign-ins tab).
    t.index(['provider_id', 'created_date_time'], 'entra_signin_events_time_idx');
    // App-filter scans.
    t.index(['provider_id', 'app_id'], 'entra_signin_events_app_idx');
    // Status filter (success vs failure).
    t.index(['provider_id', 'status_error_code'], 'entra_signin_events_status_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('entra_signin_events');
}

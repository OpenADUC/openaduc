// SPDX-License-Identifier: BUSL-1.1
import type { Knex } from 'knex';

// Two cache tables sourced from Microsoft Graph, keyed by the AD-cached
// user (object_guid). Decoupled from user_cache_records so AD sync can
// rewrite that table freely without disturbing photo bytes / sign-in stamps.
//
// Both rows are deleted by FK cascade when the user_cache_records row is
// removed (true tombstone) — we don't keep enrichment for users that no
// longer exist on the AD side.
export async function up(knex: Knex): Promise<void> {
  // ---- user_photos -----------------------------------------------------
  // Binary photo bytes pulled from Graph /users/{id}/photos/{size}/$value.
  // We keep one canonical size (240x240) — enough for the detail card and
  // the search list avatar. ETag is the value Graph returned; we send it
  // back as If-None-Match on refresh and rely on a 304 to extend TTL
  // without re-downloading bytes.
  await knex.schema.createTable('user_photos', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    // Matches user_cache_records.object_guid. Not a strict FK because the
    // photo can be inserted before / persist beyond a user-cache rewrite
    // cycle; a pruning task removes orphans.
    t.uuid('object_guid').notNullable();
    // Mime type from Graph response. Almost always image/jpeg today; kept
    // explicit so a future provider returning png/webp doesn't break.
    t.text('content_type').notNullable();
    // ETag straight from Graph — opaque to us. Null is acceptable on
    // providers that don't return one (the ETag conditional fetch just
    // becomes a normal fetch).
    t.text('etag');
    // Raw bytes. Postgres BYTEA tops out around 1GB — photos are <100KB.
    t.binary('bytes').notNullable();
    t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // null = no record from Graph (used by the photo route to return 404
    // without re-asking Graph until the next refresh task).
    t.boolean('absent').notNullable().defaultTo(false);

    t.unique(['provider_id', 'object_guid']);
    t.index(['provider_id', 'fetched_at'], 'user_photos_refresh_idx');
  });

  // ---- user_entra_enrichment ------------------------------------------
  // Sign-in activity + any other per-user Graph-sourced fields. Separate
  // table from photos so we can read it cheaply without dragging BYTEA
  // bytes into search responses.
  await knex.schema.createTable('user_entra_enrichment', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('provider_id')
      .notNullable()
      .references('id')
      .inTable('directory_providers')
      .onDelete('CASCADE');
    t.uuid('object_guid').notNullable();
    // Entra `signInActivity.lastSignInDateTime` — interactive sign-ins.
    // Null when the tenant lacks Entra ID P1 (the API returns the field
    // as null) or when the user has never signed in.
    t.timestamp('last_sign_in_at', { useTz: true });
    // Entra `signInActivity.lastNonInteractiveSignInDateTime` — service /
    // refresh-token flows. Often more recent than last_sign_in_at.
    t.timestamp('last_non_interactive_sign_in_at', { useTz: true });
    // Entra `id` (objectId) — useful when the calling code has only the
    // AD objectGuid and wants to make further Graph calls.
    t.uuid('entra_object_id');
    // Entra `userPrincipalName` — usually identical to AD's UPN, captured
    // here so we don't re-derive it on every render.
    t.text('user_principal_name');
    // 'success' | 'p1_required' | 'forbidden' | 'not_found' — the most
    // recent attempt's outcome. Lets the UI distinguish "this user has
    // never signed in" from "we couldn't fetch sign-in activity at all".
    t.text('last_status');
    t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['provider_id', 'object_guid']);
    t.index(['provider_id', 'fetched_at'], 'user_entra_enrichment_refresh_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_entra_enrichment');
  await knex.schema.dropTableIfExists('user_photos');
}

# Architecture

OpenADUC is a small monorepo: a Fastify API, a Vue 3 SPA, and a tiny shared package of Zod schemas and capability constants. The API talks to Postgres for state and to one or more domain controllers over LDAPS for the directory.

This document describes the shape of the system as it exists today. For the per-file reference, read the code; for the why-it-is-this-way reasoning, read on.

## Monorepo layout

```
apps/
  api/                       Fastify backend (TypeScript, Node 22)
    src/
      app.ts                 Plugin registration, route wiring
      server.ts              Boot and graceful shutdown
      config/env.ts          Zod env schema (single source of truth)
      plugins/               Cross-cutting Fastify plugins
        auth.ts              Session resolution, capability/step-up guards
        db.ts                Postgres pool, Kysely binding
        services.ts          Wires services onto the Fastify instance
        csrf.ts, errorHandler.ts, ...
      routes/                One file per top-level resource
      services/              Business logic (auth, audit, sessions, syncTasks/, ...)
      providers/             Directory provider abstraction
        active-directory/    LDAPS implementation (ldapts)
        registry.ts          Builds providers per request, with the right creds
      db/types.ts            Kysely-typed DB schema
      lib/                   encryption, logger, small utils
    migrations/              Knex .ts migrations (numbered, append-only)
  web/                       Vue 3 SPA (Vite, PrimeVue, Tailwind v4, Pinia)
packages/
  shared/                    Zod schemas + capability constants used by both apps
docker/                      Dockerfiles + nginx config for the web container
scripts/                     dev-kill, snapshot-db, restore-db
```

## Request flow

A request from the SPA hits the web container's nginx, which proxies `/api/*` to the API container. From there:

1. **Plugin chain** ([`app.ts`](../apps/api/src/app.ts)) — sensible, helmet (CSP report-only), CORS, cookie, rate-limit, correlation id, error handler, db, services, auth, csrf.
2. **Auth resolution** (`plugins/auth.ts` `onRequest`) — resolves the session cookie to an `admin_sessions` row, attaches `req.actor` with capabilities, optionally resolves the linked `elevated_sessions` row and looks up the cached step-up password from the in-memory `CredentialCacheService`.
3. **Capability guard** (`requireCapability(cap)` preHandler) — fails with 403 and writes an `authz.deny` audit row if the actor's capability set doesn't include `cap`.
4. **Step-up guard** (`requireStepUp` preHandler) — fails with 401 (`StepUpRequired`) if the route requires elevation and the actor has no live elevated session or no cached password (e.g. after an API restart).
5. **Handler** — typically reads/writes via a `provider` built by `providers/registry.ts`. Reads use the cached service account; writes use the operator's own credentials (cached after step-up) so AD attributes a write to the human, not a shared service account.
6. **Audit wrapper** (`withAudit()` in `services/auditContext.ts`) — wraps mutating operations to capture before/after snapshots, normalize the result, and write a row to `audit_events`.

## Data layer

**Postgres (Kysely + Knex).** Kysely is the type-safe query builder used by the application code; Knex is used only for migrations (because its CLI and migration story are mature). The schema types in [`apps/api/src/db/types.ts`](../apps/api/src/db/types.ts) drive Kysely; migrations in [`apps/api/migrations/`](../apps/api/migrations) drive the database. Migrations are forward-only and named with a timestamp prefix.

Key tables:

| Table                                                                 | Purpose                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `directory_providers`                                                 | One row per configured directory. LDAPS URLs, base DN, encrypted bind credentials.                                         |
| `admin_sessions`                                                      | One row per signed-in user session. Stores a snapshot of capabilities at sign-in time.                                     |
| `elevated_sessions`                                                   | Step-up sessions. Child of an admin session, short TTL, write-only capability subset.                                      |
| `audit_events`                                                        | Append-only. Database triggers reject `UPDATE`, `DELETE`, `TRUNCATE`. Indexed on timestamp, actor, target, correlation id. |
| `user_cache_records`, `group_cache_records`, `computer_cache_records` | Local cache of LDAP objects, refreshed by sync tasks. Search/list endpoints read from these for speed.                     |
| `user_group_memberships`                                              | Materialized user→group edges for fast membership queries.                                                                 |
| `directory_ous`                                                       | OU hierarchy cache.                                                                                                        |
| `directory_sync_tasks`                                                | One row per (directory, task type). Schedule, last run, last status, cursor for delta syncs.                               |
| `app_settings`                                                        | Operational key/value config (timeouts, schedules, branding).                                                              |

The cache tables are the answer to "why is search so fast" — every UI list view hits Postgres, not LDAP. Writes go to LDAP first, then trigger a refresh of the affected cache rows.

## Directory provider abstraction

All LDAP/AD access goes through a `Provider` interface (`apps/api/src/providers/types.ts`). The Active Directory implementation in `providers/active-directory/` uses [`ldapts`](https://github.com/ldapts/ldapts) over LDAPS. The abstraction exists so that:

- A second backend (Entra ID via Microsoft Graph, plain OpenLDAP, etc.) can be added without touching route handlers.
- Tests can inject fakes without standing up a real DC.

`providers/registry.ts` builds the right provider per request, choosing between **read mode** (binds as the cached service account) and **write-as-user mode** (binds as the operator using the step-up cached password). This is what gives every AD write the operator's identity in the AD audit trail, not a shared service account.

## Background work

Sync work runs **in-process** in the API container — there is no separate worker process. A small scheduler in [`services/syncTasks/scheduler.ts`](../apps/api/src/services/syncTasks/scheduler.ts) ticks periodically, picks the next due task per directory from `directory_sync_tasks`, and dispatches to a runner under `services/syncTasks/runners/` (one per task type — `usersDelta`, `usersFull`, `groupsDelta`, `domainPolicy`, `usersLocked`, etc.).

Each task type has a default schedule (interval, hourly, monthly) and a watchdog timeout. Failures bump a consecutive-failure counter; crossing a per-task threshold raises an operator notification.

Choosing in-process over a separate worker keeps deployment simple (one API container does everything) and avoids the operational overhead of a queue at this scale. If a future workload needs queue semantics, the abstraction is small enough to lift out.

## Frontend

The SPA is Vue 3 + Pinia + Vue Router + PrimeVue + Tailwind v4. Layout lives under `apps/web/src/design/` (Sidebar, Topbar, primitives). Each top-level route is a "view" under `apps/web/src/views/`.

Big-data tables (users, groups, computers, audit) use a shared pattern: client-side filter and sort against an already-fetched dataset, viewport-fill height, frozen header, virtual scroll, and PrimeVue's `filterDisplay="menu"`. The cache-table architecture means these views can fetch a few thousand rows once and let the user filter without round-trips.

Capabilities are mirrored client-side from the session, so the sidebar hides items the user can't act on. Server-side capability guards remain authoritative — the client check is purely UX.

## Multi-directory

The data model supports multiple `directory_providers` rows per OpenADUC instance, and most code paths take a `providerId`. The current UI assumes one. The plumbing is in place for a future multi-tenant or multi-forest deployment.

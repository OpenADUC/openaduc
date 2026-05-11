# Configuration

OpenADUC reads its configuration from environment variables (typically a `.env` file at the repo root). Most settings have sensible defaults; only a few are required.

The full env schema lives in [`apps/api/src/config/env.ts`](../apps/api/src/config/env.ts) and is enforced at startup — the API will refuse to boot on invalid values.

## Required

| Variable                | Type                    | Description                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_COOKIE_SECRET` | string, ≥32 chars       | HMAC secret used to sign session cookies. Generate with `openssl rand -hex 32`. Rotating it invalidates all active sessions.                                                                                                                                                                                           |
| `ENCRYPTION_KEY`        | base64-encoded 32 bytes | AES-256-GCM key used to encrypt service-account credentials (and other secrets) stored in Postgres. Generate with `openssl rand -base64 32`. **Losing this key makes those rows undecryptable** — back it up alongside your DB. Rotating it requires a re-encrypt migration; keep the old value in a vault until then. |
| `DATABASE_URL`          | `postgres://…`          | Postgres connection string. Pool sized via `DATABASE_POOL_MIN`/`MAX`.                                                                                                                                                                                                                                                  |

## Runtime

| Variable    | Default       | Description                                                                               |
| ----------- | ------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`  | `development` | One of `development`, `test`, `production`. Affects logging and a few defensive checks.   |
| `LOG_LEVEL` | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Use `debug` to trace LDAP operations. |

## API server

| Variable          | Default                 | Description                                                                                                  |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `API_HOST`        | `0.0.0.0`               | Bind address for the Fastify HTTP server.                                                                    |
| `API_PORT`        | `3000`                  | TCP port for the API.                                                                                        |
| `API_CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list of origins allowed by CORS. In production, set this to the public origin of the web UI. |

## Sessions and step-up

OpenADUC uses cookie-based sessions plus a separate **step-up** session minted when an admin re-authenticates to perform a write. Both have independent timeouts.

| Variable                         | Default | Description                                                                                                 |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `SESSION_IDLE_TIMEOUT_MINUTES`   | `60`    | Sign-out after this many minutes of inactivity.                                                             |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `12`    | Hard sign-out cap regardless of activity.                                                                   |
| `STEP_UP_TTL_MINUTES`            | `60`    | How long an elevated (step-up) session lasts. After expiry, write actions require re-entering the password. |

These can be overridden per-deployment via the **app_settings** table (settings UI), which takes precedence over env values once set.

## Database

| Variable            | Default | Description                                                                          |
| ------------------- | ------- | ------------------------------------------------------------------------------------ |
| `DATABASE_POOL_MIN` | `2`     | Minimum idle Postgres connections.                                                   |
| `DATABASE_POOL_MAX` | `10`    | Maximum Postgres connections. Bump if you see pool exhaustion under heavy sync load. |

## Active Directory connection

These variables only matter on **first boot before the setup wizard has run**. If they are set and no `directory_providers` row exists in the database, the API seeds one from these values. After that, the database is the source of truth and these env vars are ignored. The recommended path is to leave them blank and use the setup wizard.

| Variable                      | Default | Description                                                                                                                                                 |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AD_LDAP_URLS`                | —       | Comma- or semicolon-separated LDAP(S) URLs, e.g. `ldaps://dc1.example.com:636,ldaps://dc2.example.com:636`. Multiple URLs are tried in order with failover. |
| `AD_DOMAIN`                   | —       | Active Directory domain name (e.g. `example.com`). Used for UPN suffix matching.                                                                            |
| `AD_BASE_DN`                  | —       | Base DN for searches (e.g. `DC=example,DC=com`).                                                                                                            |
| `AD_SERVICE_ACCOUNT_UPN`      | —       | UPN of the read/sync service account (e.g. `openaduc-sync@example.com`).                                                                                    |
| `AD_SERVICE_ACCOUNT_PASSWORD` | —       | Password for the service account. Stored encrypted in the DB once seeded.                                                                                   |
| `AD_TLS_REJECT_UNAUTHORIZED`  | `1`     | Set to `0` only for local dev with self-signed Samba. **Never** set to `0` in production.                                                                   |
| `AD_TLS_CA_PATH`              | —       | Path inside the API container to a custom CA bundle (PEM) used to validate the LDAPS certificate.                                                           |
| `AD_OPERATION_TIMEOUT_MS`     | `15000` | Timeout (in ms) for individual LDAP operations. Increase if your DCs are slow or far away.                                                                  |

## Authorization bootstrap

| Variable                   | Default | Description                                                                                                                                                                                                         |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_GROUP_DN` | —       | DN of an AD security group whose members are auto-granted the `admin` role until in-app role assignments are configured. The setup wizard sets this for you. The recovery account from the wizard works without it. |

## Frontend (build-time)

| Variable            | Default | Description                                                                                                                                                                   |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | `/api`  | Path the SPA uses to reach the API. The default assumes the API is fronted at the same origin under `/api` (the bundled `nginx` config in `docker/web.Dockerfile` does this). |

## Operational settings (in-app, not env)

A handful of settings live in the **app_settings** Postgres table and are managed through the Settings UI rather than env vars:

- Domain default password policy snapshot (refreshed periodically from AD).
- Per-task sync schedules (interval, cron).
- Notification thresholds for failing sync tasks.
- Branding overrides (display name, accent color).

Env defaults in this file are the floor; the database wins where both exist.

## Rotation guidance

- **`SESSION_COOKIE_SECRET`** — rotate as needed. All users are signed out and must log back in. Safe to do.
- **`ENCRYPTION_KEY`** — **do not rotate** unless you also run a re-encryption pass over the affected rows (`directory_providers.bind_secret_encrypted`, integration secrets). A future migration tool will support online rekey; for now treat this like a Postgres encryption key.
- **`AD_SERVICE_ACCOUNT_PASSWORD`** — change in AD, then update via the Settings → Configuration UI (which re-encrypts and stores it). Do not edit the env value after first boot; it has no effect once a `directory_providers` row exists.

# Security

OpenADUC sits in front of Active Directory and writes to it on behalf of operators. The threat surface is "an attacker who can get a session as an OpenADUC admin can do anything that admin can do in AD." Everything below is in service of narrowing that surface.

This document is a high-level summary. Implementation details are in [`apps/api/src/services/`](../apps/api/src/services), [`apps/api/src/plugins/auth.ts`](../apps/api/src/plugins/auth.ts), and [`apps/api/src/lib/encryption.ts`](../apps/api/src/lib/encryption.ts).

## Threat model summary

- **In scope.** Privilege escalation by authenticated users, capability bypass, session theft, audit tampering, secrets extraction from the database, write-as-user impersonation.
- **Out of scope.** Compromise of the host operating system, compromise of the domain controller itself, denial of service, social engineering, and physical security. The dev-mode Samba container shipped for local development is explicitly **not hardened** and should never be used in production.

## Authentication

Operators sign in with their Active Directory username and password. The API performs a live LDAPS bind against a domain controller — there is no in-app password hash, no local password store outside the recovery account.

The recovery account, created during the first-run wizard, exists so an operator can recover access if the AD link is broken (DC outage, expired service account, mis-configured group). It uses Argon2id-hashed credentials and is intended as a break-glass route only.

## Sessions

Successful sign-in mints an `admin_sessions` row and a signed cookie. The session stores a **snapshot** of the operator's capabilities at sign-in — role changes do not take effect until the next login. This is deliberate: it makes sessions auditable and prevents a quietly-revoked role from leaving an active session with elevated rights.

Two timeouts apply, both configurable:

- **Idle timeout** (`SESSION_IDLE_TIMEOUT_MINUTES`, default 60 min) — sliding window, refreshed on every authenticated request.
- **Absolute timeout** (`SESSION_ABSOLUTE_TIMEOUT_HOURS`, default 12 h) — hard cap from sign-in regardless of activity.

The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and signed with `SESSION_COOKIE_SECRET`. Rotating that secret invalidates all sessions.

## Capabilities

Authorization is capability-based, not role-based at the call site. Routes declare the capability they need (`app.requireCapability('write:user.resetPassword')`) and the auth plugin checks the actor's snapshot. Roles (`admin`, `operator`, `auditor`) are convenience bundles defined in [`packages/shared/src/capabilities.ts`](../packages/shared/src/capabilities.ts) — adding a role is a config change, not a code change.

The capability set is intentionally fine-grained (`read:user`, `write:user.resetPassword`, `write:user.unlock`, `write:user.attributes`, `write:group.membership`, `configure:directory`, `view:audit`, `view:raw_attributes`, etc.) so that giving someone "the ability to unlock accounts" doesn't also give them "the ability to reset passwords."

A failed capability check returns 403 and writes an `authz.deny` row to the audit log with the required capability, the actor, and the request correlation id.

## Step-up authentication

Mutating routes require **step-up auth**: the operator re-enters their AD password, the API rebinds against the directory, and on success mints an `elevated_sessions` row with a short TTL (`STEP_UP_TTL_MINUTES`, default 60 min) and a write-only subset of capabilities.

The operator's password is held only in process memory in `CredentialCacheService`. It lives in a `Buffer` that is zeroed on eviction, expires at the elevated session TTL, and is never written to disk or the database. An API restart wipes all cached passwords, forcing re-step-up — which is intentional.

This is what enables **write-as-user**: every AD modification is bound as the operator, not as a shared service account, so AD's own audit log attributes the change to the right human.

## Audit

Every authenticated action — successful or denied — produces an `audit_events` row. The table is append-only at the database level: a trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE` on the table, so even a compromised application cannot silently rewrite history.

Each row captures: action, actor, target type and id, before/after JSON snapshots, source IP, user agent, session id, correlation id, error code, and arbitrary metadata. Keys matching a sensitive-key allowlist (`password`, `secret`, `token`, etc.) are auto-redacted to `[REDACTED]` before insert.

Audit retention is unbounded by default. Operators can prune older rows out-of-band if needed, but the application will not.

## Encryption at rest

Secrets stored in Postgres are encrypted with **AES-256-GCM** using `ENCRYPTION_KEY`. Affected fields:

- `directory_providers.bind_secret_encrypted` — service account password.
- `directory_entra_integrations.client_secret_encrypted` — Entra app secret (when configured).
- `directory_entra_integrations.teams_webhook_url_encrypted` — Teams webhook URLs.

Ciphertexts are stored as `v1.<iv-b64url>.<ct-b64url>.<tag-b64url>`. The version prefix lets us migrate to a new construction or key without breaking older rows. Losing `ENCRYPTION_KEY` makes these rows undecryptable; **back it up alongside your database backups**.

The operator step-up password is **never** encrypted to disk — it only lives in process memory.

## AD-specific risks

Some risks are inherent to writing to AD; OpenADUC mitigates them but cannot eliminate them.

- **Account lockouts via `lockoutTime` writes.** OpenADUC's unlock endpoint zeroes `lockoutTime` rather than incrementing `badPwdCount`. A buggy or malicious caller using raw attribute write would still be capability-gated by `write:user.attributes` and audit-logged.
- **Password reset replication delay.** A password reset against one DC may take seconds to replicate; the API does not poll for replication. The audit row records which DC was written to.
- **Service account scope.** The bootstrap service account only needs read for sync. Write capabilities (`User-Force-Change-Password`, `Reset Password`, `Account Restrictions`) should be **delegated on the OUs you intend to manage**, not granted forest-wide. The setup wizard's documentation links walk through the recommended delegations.
- **LDAPS certificate validation.** Production deployments must keep `AD_TLS_REJECT_UNAUTHORIZED=1`. Setting it to `0` (only valid for the local Samba dev container) disables hostname verification and exposes operator credentials to MITM.

## Reporting a vulnerability

Please report security issues privately — see [SECURITY.md](../SECURITY.md). Do not open a public GitHub issue.

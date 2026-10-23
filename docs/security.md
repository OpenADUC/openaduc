# Security

OpenADUC sits in front of Active Directory and writes to it on behalf of operators. The threat surface is "an attacker who can get a session as an OpenADUC admin can do anything that admin can do in AD." Everything below is in service of narrowing that surface.

This document is a high-level summary. Implementation details are in [`apps/api/src/services/`](../apps/api/src/services), [`apps/api/src/plugins/auth.ts`](../apps/api/src/plugins/auth.ts), and [`apps/api/src/lib/encryption.ts`](../apps/api/src/lib/encryption.ts).

## Threat model summary

- **In scope.** Privilege escalation by authenticated users, capability bypass, session theft, audit tampering, secrets extraction from the database, write-as-user impersonation.
- **Out of scope.** Compromise of the host operating system, compromise of the domain controller itself, denial of service, social engineering, and physical security. The dev-mode Samba container shipped for local development is explicitly **not hardened** and should never be used in production.

## Authentication

Operators sign in with their Active Directory username and password. The API performs a live LDAPS bind against a domain controller — there is no in-app password hash and no local password store.

Every failed sign-in gets the same answer, whatever AD said (unknown user, wrong password, locked, disabled, expired, or no OpenADUC role), and directory outages don't reveal hosts or error text. The specific reason is recorded in the audit log. Step-up failures follow the same rule.

There is no local break-glass account yet: if every domain controller is unreachable, or no one is left in a role group, nobody can sign in until that's fixed in AD.

## Sessions

Successful sign-in mints an `admin_sessions` row and a signed cookie. The session stores a **snapshot** of the operator's capabilities, resolved from their AD group memberships at sign-in.

Every step-up re-reads those memberships from the fresh bind and replaces the snapshot. An operator removed from a role group loses that role's capabilities at their next step-up, and one left with no role is signed out. Stepping up never extends the session's absolute expiry. The worst case for a removed operator is therefore: write access until their current elevated session ends (see [step-up](#step-up-authentication)), and read access until the session itself ends (idle or absolute timeout below). To cut access immediately, disable the AD account: binds then fail, so they can't step up again.

Two timeouts apply, both configurable:

- **Idle timeout** (`SESSION_IDLE_TIMEOUT_MINUTES`, default 60 min) — sliding window, refreshed on every authenticated request.
- **Absolute timeout** (`SESSION_ABSOLUTE_TIMEOUT_HOURS`, default 12 h) — hard cap from sign-in regardless of activity.

The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and signed with `SESSION_COOKIE_SECRET`. Rotating that secret invalidates all sessions.

## Capabilities

Authorization is capability-based, not role-based at the call site. Each route declares a policy, the capability it needs (`config: { policy: { capability: 'write:user.resetPassword', stepUp: true, directory: 'caller' } }`), and the auth plugin checks it against the actor's snapshot. Roles (`admin`, `operator`, `auditor`) are convenience bundles defined in [`packages/shared/src/capabilities.ts`](../packages/shared/src/capabilities.ts) — adding a role is a config change, not a code change.

Each role is granted to the **direct** members of one AD group; nested membership isn't followed yet. First-run setup grants admin only to a direct member of the admin group: `BOOTSTRAP_ADMIN_GROUP_DN` when set, otherwise Domain Admins. It checks this before anything is saved; whoever reaches a fresh install first can't make themselves admin with an ordinary domain account. The later setup steps require the admin capability, and once setup is done the public status endpoint reveals only that it's done.

The capability set is intentionally fine-grained (`read:user`, `write:user.resetPassword`, `write:user.unlock`, `write:user.attributes`, `write:group.membership`, `configure:directory`, `view:audit`, `view:raw_attributes`, etc.) so that giving someone "the ability to unlock accounts" doesn't also give them "the ability to reset passwords." A password reset can also clear the account's lockout in the same directory change; asking it to needs `write:user.unlock` as well, checked and audited like the route's own capability.

Three writes carry extra guard rails because they're hard to undo:

- **Delete** (`write:user.delete`, admin role only) works on disabled accounts only, and never on accounts AD marks `isCriticalSystemObject` or creates for itself (RID below 1000: Guest, krbtgt, DefaultAccount, …). The API re-checks both against the live entry immediately before deleting, and each request must repeat the account's sAMAccountName, so a stale list or a wrong id can't delete the wrong person. The audit row keeps the account's attributes and group memberships, which is the only record left on domains without the AD Recycle Bin.
- **Rename** (`write:user.rename`, admin and operator) changes how a person signs in: cn, sAMAccountName, userPrincipalName and the primary SMTP address. New values are checked for collisions across the domain before anything is written, and if the attribute write fails after the cn has changed, the cn is renamed back.
- **Group delete** (`write:group.delete`, admin role only; map another group to the admin role, or change the role bundles, to grant it more widely) refuses:
  - critical system objects (`isCriticalSystemObject`);
  - built-in groups: in `CN=Builtin`, flagged builtin in `groupType`, or a well-known RID below 1000;
  - groups AdminSDHolder protects (`adminCount=1`);
  - groups mapped to an OpenADUC role, which would lock that role out;
  - groups directly in a protected group (Administrators, Account/Server/Print/Backup Operators, Replicator, Domain Admins, Domain Controllers, Schema Admins, Enterprise Admins, Read-only Domain Controllers, Key Admins, Enterprise Key Admins, recognized by well-known SID, or any `adminCount=1` group), since AdminSDHolder may not have flagged them yet. DnsAdmins and DnsUpdateProxy have no well-known SID, so only their `adminCount` protects them;
  - groups that are some account's primary group (`primaryGroupID`), which AD refuses anyway.

  The API checks these against the live entry, its parent groups and AD's primary-group count, again on the operator's own bind immediately before deleting, and audits a refusal as a failed `group.delete` with the reason. Each request must repeat the group's pre-Windows 2000 name. The audit row keeps the group's members and parent groups, which a tombstone doesn't.

Creating a group (`write:group.create`, admin and operator) checks its name among the OU's children and its pre-Windows 2000 name across the domain, both before the operator submits and again on the operator's own bind before writing.

Computer accounts can be disabled and enabled (`write:computer.enableDisable`), moved (`write:computer.move`) and reset (`write:computer.resetAccount`), all three admin and operator. Reset works as ADUC's Reset Account does: the password becomes the lowercase computer name without the `$`, cut to 14 characters, which is what a computer rejoining under the same name tries. The domain password policy doesn't apply to machine accounts, so the short password is accepted; the operator needs the Reset Password right on the computer. Until it rejoins, the computer can't authenticate to the domain, so the UI asks first.

A failed capability check returns 403 and writes an `authz.deny` row to the audit log with the required capability, the actor, and the request correlation id.

## Step-up authentication

Mutating routes require **step-up auth**: the operator re-enters their AD password, the API rebinds against the directory, and on success mints an `elevated_sessions` row with a write-only subset of capabilities.

The elevated session ends at whichever comes first:

- **Idle timeout** (`stepup.idle_timeout_minutes`, default 15 min): every authenticated request from the operator pushes it back. Requests the SPA makes by itself, polling a running sync task, are marked `x-background-request: 1` and don't count. To spare the database, a request that would move it by less than a twentieth of the timeout isn't recorded, so the session can end up to that much early.
- **Absolute lifetime** (`stepup.absolute_lifetime_minutes`, default 4 h): counted from step-up, however active the operator is. An elevated session also never outlives the session it belongs to: its idle timeout is capped by the session's, and its absolute end by the session's.

Both are policy settings (**Settings → Policy**). Changing them requires step-up and writes a `settings.update` audit row; a new idle timeout applies to open elevated sessions at their next request, a new absolute lifetime from the next step-up.

The web UI has no mode to enter (see [ADR 0001](adr/0001-step-up-without-edit-mode.md)). Write-capable operators always see editable fields and actions, and dialogs open without step-up; a write without an elevated session prompts step-up and then completes. While an elevated session lives, a quiet indicator by the operator's name in the sidebar (in the Old School view, the status bar) says when it ends if idle and lets them end it at once. When it ends, unsaved edits stay on screen and the next save prompts step-up again.

The operator's password is held only in process memory in `CredentialCacheService`. It lives in a `Buffer` that is zeroed on eviction, is evicted when the elevated session ends by either limit (a sweep every few seconds catches an operator who never comes back), and is never written to disk or the database. An API restart wipes all cached passwords, forcing re-step-up — which is intentional.

This is what enables **write-as-user**: every AD modification is bound as the operator, not as a shared service account, so AD's own audit log attributes the change to the right human.

## Audit

Every authenticated action — successful or denied — produces an `audit_events` row. The table is append-only at the database level: a trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE` on the table, so even a compromised application cannot silently rewrite history.

Each row captures: action, actor, target type and id, before/after JSON snapshots, source IP, user agent, session id, correlation id, error code, and arbitrary metadata. Keys matching a sensitive-key allowlist (`password`, `secret`, `token`, etc.) are auto-redacted to `[REDACTED]` before insert.

Each row also names the directory it belongs to: the one the action targeted, else the one the operator was signed in to. The audit log shows an auditor only their own directory's rows, plus installation-wide ones (settings changes, first-run setup), which name no directory and appear in every directory's log.

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
- **Secrets the service account can read.** Sync reads every attribute the service account is allowed to see. If it can read LAPS passwords (legacy `ms-Mcs-AdmPwd` or Windows LAPS), gMSA passwords or BitLocker recovery keys, OpenADUC drops them as they're read: they are never cached, returned by the API or shown. Even so, don't grant the service account those rights.
- **Raw attributes.** The full attribute set of users, computers, deleted objects and GPOs (the Raw LDAP tab and the old-school Attribute Editor) is returned only to holders of `view:raw_attributes` (admins by default). Other readers get typed fields only, and the raw tabs are hidden.
- **LDAPS certificate validation.** Production deployments must keep `AD_TLS_REJECT_UNAUTHORIZED=1`. Setting it to `0` (only valid for the local Samba dev container) disables hostname verification and exposes operator credentials to MITM.

## Reporting a vulnerability

Please report security issues privately — see [SECURITY.md](../SECURITY.md). Do not open a public GitHub issue.

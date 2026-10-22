OpenADUC: a self-hosted web replacement for Active Directory Users and Computers, talking to domain controllers over LDAPS with an append-only audit trail.

Stage: live

## Checks

Run `pnpm check` before pushing; it runs everything CI runs. Git hooks (installed by `pnpm install`) format staged files and reject `Co-Authored-By: Claude` trailers: don't add AI co-author trailers to commits.

## Local directory and API

`pnpm dc:up` starts a seeded Samba AD DC for development and tests (`ldaps://localhost:10636`, base DN `DC=openaduc,DC=test`); `dev/samba-dc/README.md` lists fixture accounts, passwords and how to map roles. Use it instead of building your own DC. The API's health endpoints are `/health/live`, `/health/ready` and `/health/directory`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on OpenADUC/openaduc, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` and `docs/adr/`, both created lazily. See `docs/agents/domain.md`.

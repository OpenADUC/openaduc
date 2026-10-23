# The Old School view is a skin over shared workflows

We keep two UIs: the main app, and the Old School view that recreates the ADUC MMC. Both call the same API, but each used to implement its own workflow logic (call order, step-up retry, preflight, validation, partial failures), so the two drifted. For example, only the Old School reset dialog could also unlock the account.

The Old School view holds no workflow logic. Every operation is either a compound operation in the API (one call, one audit event, one permission check) or a shared headless workflow that both UIs render. The Old School view may not call the API directly. ESLint enforces this: `pnpm lint` fails when anything under `apps/web/src/oldschool/` imports the API client.

A new feature ships its workflow in the shared layer. Its Old School rendering can follow in a later ticket, but the feature can't be built so that adding it there later means rewriting the logic.

## Considered options

- **Freeze the Old School view** with a limited feature set. Rejected: we want it kept current.
- **Remove it.**

# Development

This guide is for working on OpenADUC itself — running the stack from source, hacking on the API or web, adding migrations.

## Prerequisites

- **Node.js 22** (`.nvmrc` pins the exact patch version — `nvm use` will pick it up).
- **pnpm 10** (`corepack enable && corepack prepare pnpm@10 --activate` is the easy path).
- **Docker** with Compose v2 — used for Postgres and (optionally) a local Samba AD-DC container.
- **A directory to talk to.** Either a real test AD (preferred), or the bundled dev Samba container (see below). Pointing dev at a production DC is a bad idea.

## First-time setup

```bash
git clone https://github.com/OpenADUC/openaduc.git
cd openaduc
nvm use            # picks Node from .nvmrc
pnpm install
cp .env.example .env
# Generate dev secrets:
echo "SESSION_COOKIE_SECRET=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"     >> .env
docker compose up -d postgres
pnpm migrate:latest
pnpm dev
```

`pnpm dev` runs every workspace's `dev` script in parallel:

- `apps/api` — `tsx watch src/server.ts` on port 3000.
- `apps/web` — Vite dev server on port 5173 with HMR.
- `packages/shared` — `tsc --watch` so schema changes propagate to both apps.

Open `http://localhost:5173` and step through the first-run wizard.

## Local Active Directory

You need an LDAPS-reachable directory to develop against. Two options:

**Real test AD (preferred).** A throwaway Windows Server VM running AD DS, on a subnet your dev machine can route to. This is the most faithful target. Point the setup wizard at its LDAPS URL and base DN.

**Containerized Samba AD-DC.** `docker-compose.dev.yml` ships with a `samba-ad-dc` service block, **commented out**. Getting a Samba domain controller stable in a container (image choice, env vars, TLS bootstrap, hostname resolution) is image-specific and finicky enough that we don't ship a one-click recipe. Uncomment the block, pick a samba-domain image you trust, and adapt — or use a real AD VM.

When you have a directory reachable, configure these in `.env` before first boot:

```env
AD_LDAP_URLS=ldaps://your-dc.example.local:636
AD_DOMAIN=example.local
AD_BASE_DN=DC=example,DC=local
AD_SERVICE_ACCOUNT_UPN=openaduc-sync@example.local
AD_SERVICE_ACCOUNT_PASSWORD=<the SA password>
AD_TLS_REJECT_UNAUTHORIZED=0   # only for self-signed dev certs
```

`AD_TLS_REJECT_UNAUTHORIZED=0` is acceptable for a self-signed local DC; **never** set it for production.

To bring up the dev stack with hot reload and exposed Postgres:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

## Common tasks

| Task                                     | Command                            |
| ---------------------------------------- | ---------------------------------- |
| Run all dev servers                      | `pnpm dev`                         |
| Kill orphaned dev processes on 3000/5173 | `pnpm dev:kill`                    |
| Hard reset (kill + restart)              | `pnpm dev:reset`                   |
| Apply pending migrations                 | `pnpm migrate:latest`              |
| Roll back the last migration batch       | `pnpm migrate:rollback`            |
| Generate a new migration                 | `pnpm migrate:make <name>`         |
| Type-check everything                    | `pnpm typecheck`                   |
| Run unit tests                           | `pnpm test`                        |
| Lint                                     | `pnpm lint`                        |
| Format                                   | `pnpm format`                      |
| Snapshot the dev database                | `scripts/snapshot-db.sh`           |
| Restore a snapshot                       | `scripts/restore-db.sh <snapshot>` |

## Conventions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`. Scopes are loose; use them when they help.
- **Comments.** Default to writing none. Add one only when the _why_ is non-obvious — a hidden constraint, a workaround, a subtle invariant. Don't restate what the code already says.
- **Tests.** Vitest for unit tests, Playwright for end-to-end. New API routes need at least a happy-path integration test that hits the real Postgres.
- **Schemas.** Cross-app types live in `packages/shared/src/schemas/` as Zod. The API validates request and response bodies against them; the SPA imports the inferred types.
- **Migrations are forever.** Once a migration is on `main`, never edit it. Write a new one.

## Repo layout

See [architecture.md](architecture.md) for the full tour. The short version:

```
apps/api/      Fastify backend
apps/web/      Vue 3 SPA
packages/shared/  Zod schemas + capability constants
docker/        Container build context
scripts/       dev-kill, snapshot/restore
```

## Pull requests

1. Branch from `main` (`git checkout -b feat/short-description`).
2. Make your change. Keep commits reviewable; rebase to clean up before opening the PR.
3. Run `pnpm typecheck && pnpm lint && pnpm test` locally.
4. Open the PR against `main`. The template asks for a summary, screenshots if UI-touching, and a test plan.
5. CI runs the same checks. PRs need a green build and one approval before merge.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the longer version, including the contributor license note.

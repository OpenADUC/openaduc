# Development

This guide is for working on OpenADUC itself — running the stack from source, hacking on the API or web, adding migrations.

## Prerequisites

- **Node.js 22.18 or newer in the Node 22 release line** (`.nvmrc` selects Node 22; `nvm install && nvm use` installs and selects its latest patch). graphile-worker 0.18 and the Babel 8 parser that vue-router 5.4 pulls in require at least 22.18, and `.npmrc` sets `engine-strict`, so older patches fail `pnpm install`.
- **pnpm 10** (`corepack enable && corepack prepare pnpm@10 --activate` is the easy path).
- **Docker** with Compose v2, for Postgres and the development Samba AD DC.
- **A directory to talk to.** The bundled Samba DC (`pnpm dc:up`, see below) or a real test AD. Pointing dev at a production DC is a bad idea.

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

**Bundled Samba AD DC (quickest).** `pnpm dc:up` starts a seeded Samba domain controller on `ldaps://localhost:10636` with operators for each role, a disabled user, a locked-out user, nested groups and computers. [`dev/samba-dc/README.md`](../dev/samba-dc/README.md) lists the fixtures, their passwords and how to point the setup wizard at it. `pnpm dc:down` deletes it.

**Real test AD (most faithful).** A throwaway Windows Server VM running AD DS, on a subnet your dev machine can route to. Samba covers most of what OpenADUC touches, but check AD-specific behaviour (LAPS, Exchange attributes, the Recycle Bin, fine-grained password policies) against real AD. Point the setup wizard at its LDAPS URL and base DN.

To configure the directory from `.env` instead of the wizard, set these before first boot:

```env
AD_LDAP_URLS=ldaps://localhost:10636
AD_DOMAIN=openaduc.test
AD_BASE_DN=DC=openaduc,DC=test
AD_SERVICE_ACCOUNT_UPN=svc-openaduc@openaduc.test
AD_SERVICE_ACCOUNT_PASSWORD=OpenADUC-dev-User1
AD_TLS_CA_PATH=/absolute/path/to/dev/samba-dc/.generated/ca.pem
```

For a real AD, use its LDAPS URL, base DN and service account, and its CA. `AD_TLS_REJECT_UNAUTHORIZED=0` skips certificate checks; avoid it even in development now that the bundled DC ships a CA, and **never** set it in production.

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
| Run everything CI runs                   | `pnpm check`                       |
| Type-check everything                    | `pnpm typecheck`                   |
| Run unit tests                           | `pnpm test`                        |
| Lint                                     | `pnpm lint`                        |
| Format                                   | `pnpm format`                      |
| Snapshot the dev database                | `scripts/snapshot-db.sh`           |
| Restore a snapshot                       | `scripts/restore-db.sh <snapshot>` |

## Conventions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`. Scopes are loose; use them when they help.
- **Comments.** Default to writing none. Add one only when the _why_ is non-obvious — a hidden constraint, a workaround, a subtle invariant. Don't restate what the code already says.
- **Tests.** Vitest unit tests sit next to the code they cover (`*.test.ts`). There are no route integration or browser end-to-end tests yet; exercise route changes against the bundled Samba DC.
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

Dependabot groups related dependency updates in `.github/dependabot.yml`. Keep
`@types/node` on the same major version as `.nvmrc` and the Docker images; its
automatic major updates are ignored until the runtime is upgraded. The ESLint
group includes `typescript-eslint` so the parser and lint rules update together.

1. Branch from `main` (`git checkout -b feat/short-description`).
2. Make your change. Keep commits reviewable; rebase to clean up before opening the PR.
3. Run `pnpm check` locally. It runs what CI runs: format check, the control-character check, typecheck, lint, tests and build. The pre-commit hook formats staged files with Prettier, so formatting rarely fails here.
4. Open the PR against `main`. The template asks for a summary, screenshots if UI-touching, and a test plan.
5. CI runs the same checks. PRs need a green build and one approval before merge.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the longer version, including the contributor license note.

# Contributing to OpenADUC

Thanks for your interest. OpenADUC is pre-1.0 and bug reports, fixes, and well-scoped feature PRs are all welcome.

## Before you start

- **Open an issue first for non-trivial changes.** New features, large refactors, and protocol/schema changes deserve a quick discussion before you write code, so we can flag conflicts with in-flight work or scope concerns early. Small fixes (typos, obvious bugs, doc clarifications) can go straight to a PR.
- **Read [docs/development.md](docs/development.md).** It covers prerequisites, the dev workflow, migrations, the local Samba container, and the test commands.
- **Security issues:** do **not** open a public issue or PR. See [SECURITY.md](SECURITY.md) for private reporting channels.

## Development quickstart

```bash
git clone https://github.com/OpenADUC/openaduc.git
cd openaduc
nvm use && corepack enable
pnpm install
cp .env.example .env   # then fill in / generate secrets per docs/development.md
docker compose up -d postgres
pnpm migrate:latest
pnpm dev
```

Full instructions, including local Samba AD setup and per-package test commands, are in [docs/development.md](docs/development.md).

## Making a change

1. **Branch from `main`.** Use a short descriptive branch name (`fix/locked-count-refresh`, `feat/bulk-disable`).
2. **Keep PRs focused.** One logical change per PR. If you're touching unrelated nits along the way, split them out.
3. **Add or update tests** for behavior you change. The API uses Vitest; the web app uses Vitest + Playwright. Untested behavior changes will be asked for tests on review.
4. **Run the checks locally before pushing:**
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```
   CI runs the same set. PRs that don't pass CI won't be reviewed until they do.
5. **Migrations** must be additive and reversible where possible. Never edit a migration that has already shipped in a tagged release — write a new one.
6. **Don't commit generated files, `.env`, `node_modules/`, or anything else covered by `.gitignore`.**

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body explaining the why, wrapped at ~72 chars>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `polish`. Scope is usually `api`, `web`, `shared`, or `docker`. Keep the summary line under ~70 characters.

## Code style

- TypeScript on both sides. No `any` without an explicit comment explaining why.
- Lint and format via ESLint + Prettier — `pnpm lint --fix` and `pnpm format` handle most things.
- Backend: Fastify plugins for cross-cutting concerns, services for business logic, routes are thin. Use Kysely for queries, Knex for migrations.
- Frontend: Vue 3 `<script setup>` with TypeScript. PrimeVue components first, Tailwind v4 utilities for layout. Pinia for shared state; per-view state stays in the component.
- See [docs/architecture.md](docs/architecture.md) for the bigger picture.

## Reviews and merging

- A maintainer will review within a week. Pings are fine if it's been longer.
- PRs are squash-merged. Your commit message will become the squash message — write it like you want it to appear in the changelog.
- By contributing, you agree that your contributions are licensed under the project's [Business Source License 1.1](LICENSE), with the same Change Date and Change License as the rest of the project.

## What we're unlikely to merge

- Changes that broaden the production-use grant in [LICENSE](LICENSE) (the BSL terms are deliberate).
- Plain-LDAP (port 389) support — OpenADUC is LDAPS-only by design.
- Direct DC access without going through the directory provider abstraction.
- New runtime dependencies for trivial functionality.

If you're not sure whether something fits, ask in an issue before investing time. Thanks again.

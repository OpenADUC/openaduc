# Installation

OpenADUC ships as a small Docker Compose stack: an API container, a web container, and (optionally) a Postgres container. You only need a Linux host with Docker Engine and the `docker compose` v2 plugin.

## Requirements

See the [Requirements section in the README](../README.md#requirements) for the authoritative list — host sizing, network, database (embedded vs. external Postgres, supported versions, required extensions), and AD prerequisites.

In short, you need a 64-bit Linux host with Docker Engine 24+ and the Compose v2 plugin, outbound LDAPS to your domain controllers, an AD service account, and a TLS-terminating reverse proxy in front of the bundled web container for production use.

## One-line install (recommended)

On the host that will run OpenADUC:

```bash
curl -fsSL https://raw.githubusercontent.com/OpenADUC/openaduc/main/install.sh | bash
```

The installer:

1. Verifies Docker and Compose v2 are present.
2. Asks for an install directory (default `/opt/openaduc`).
3. Asks whether to use the **bundled Postgres** container or an **existing Postgres** server. If external, prompts for host, port, database, username, password.
4. Asks for the public origin URL the web UI will be served at (e.g. `https://aduc.example.com`).
5. Generates strong random secrets (`SESSION_COOKIE_SECRET`, `ENCRYPTION_KEY`) and writes a `.env` file.
6. Pulls/builds the images and runs `docker compose up -d`.
7. Waits for Postgres to be healthy, then runs database migrations.
8. Prints the URL to open in a browser to complete the **first-run setup wizard**.

The installer is idempotent — running it again on an existing install offers `upgrade`, `reconfigure`, or `abort`. It will not overwrite an existing `.env` without prompting.

## Manual install

If you'd rather drive it yourself:

```bash
# 1. Clone or download a release tarball
git clone https://github.com/OpenADUC/openaduc.git
cd openaduc

# 2. Copy and edit the env file
cp .env.example .env
# At minimum, generate strong values for:
#   SESSION_COOKIE_SECRET   (>= 32 chars, e.g. openssl rand -hex 32)
#   ENCRYPTION_KEY          (base64 32 bytes, e.g. openssl rand -base64 32)
# Set DATABASE_URL to point at your Postgres (or keep the default for the bundled one).

# 3. Bring the stack up
docker compose up -d

# 4. Run migrations (the API container also runs them on boot, but you can pre-run)
docker compose exec api pnpm migrate:latest
```

The web UI listens on `:8080` inside the `web` container. Map it to a host port or front it with your reverse proxy of choice.

## First-run setup wizard

On first visit to the web UI you are taken through a four-step wizard:

1. **Recovery account** — create a local username/password used to bootstrap administration before any AD identity has been linked. Save these credentials somewhere safe; this account is your break-glass route back in.
2. **Directory connection** — LDAPS URL(s), base DN, and a service account UPN/password. The wizard performs a live bind to validate them.
3. **Authorization bootstrap** — pick an AD security group whose members get the `admin` role. This is what lets your normal AD account sign in with full capabilities.
4. **Recap & finish** — review choices and commit.

After the wizard finishes, OpenADUC schedules its background sync tasks (delta + periodic full sync of users, groups, computers, OUs) and you can sign in with an AD account.

## Upgrading

For a one-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/OpenADUC/openaduc/main/install.sh | bash
# Choose "upgrade" when prompted.
```

For a manual install:

```bash
cd /opt/openaduc           # or wherever you cloned
git pull                   # or download the new release tarball
docker compose pull        # if using published images
docker compose up -d       # restart with new images
docker compose exec api pnpm migrate:latest
```

Migrations are forward-compatible within a minor version. Read the [CHANGELOG](../CHANGELOG.md) before upgrading across minor versions.

## Uninstall

```bash
cd /opt/openaduc
docker compose down -v     # the -v also removes the bundled Postgres volume
rm -rf /opt/openaduc
```

This removes the application, its containers, and (with `-v`) the embedded database. Audit history lives in the database, so back it up first if you want to retain it (`docker compose exec postgres pg_dump -U openaduc openaduc > backup.sql`).

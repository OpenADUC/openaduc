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

On first visit to the web UI you are taken through the setup wizard:

1. **Domain** — domain name, base DN, domain controllers and connection security (LDAPS, or StartTLS on the LDAP port), then an AD administrator's username and password. The wizard binds as that account to check the connection and signs you in. Members of Domain Admins get the OpenADUC `admin` role.
2. **Service account** — a read-only AD account for background sync. The wizard binds as it to check the password, then stores it encrypted. If you use fine-grained password policies, give it Read on them (in `CN=Password Settings Container,CN=System`) so a locked user's page can say when their lockout ends; by default only Domain Admins can read them, and the page says the end is unknown.
3. **Policy** — how many days ahead to warn about expiring passwords, and how long without a logon makes an account stale.
4. **Initial sync** — reads the domain policy, OUs, users, groups, computers and group memberships.
5. **Done** — background sync tasks are scheduled and you land in the app.

There is no local break-glass account: every sign-in is an AD bind.

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

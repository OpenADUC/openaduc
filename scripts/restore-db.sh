#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Restore the openaduc postgres database from ./snapshots/<name>.dump.
# DESTRUCTIVE: drops and recreates the openaduc database.
#
# Usage:
#   scripts/restore-db.sh test-ad
set -euo pipefail

NAME="${1:-}"
if [[ -z "${NAME}" ]]; then
  echo "usage: $(basename "$0") <snapshot-name>" >&2
  echo "available snapshots:" >&2
  ls -1 "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/snapshots" 2>/dev/null | sed 's/\.dump$//' | sed 's/^/  /' >&2 || echo "  (none)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_FILE="${REPO_ROOT}/snapshots/${NAME}.dump"

if [[ ! -f "${SNAP_FILE}" ]]; then
  echo "no such snapshot: ${SNAP_FILE}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

echo "==> WARNING: this will DROP the current openaduc database and replace it"
echo "    with the contents of ${SNAP_FILE}."
read -r -p "Continue? [y/N] " ans
[[ "${ans}" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }

echo "==> stopping api/worker so they release their DB connections..."
docker compose stop api worker || true

echo "==> copying dump into postgres container..."
docker compose cp "${SNAP_FILE}" postgres:/tmp/restore.dump

echo "==> dropping and recreating database..."
docker compose exec -T postgres psql -U openaduc -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS openaduc WITH (FORCE); CREATE DATABASE openaduc OWNER openaduc;"

echo "==> restoring..."
docker compose exec -T postgres pg_restore -U openaduc -d openaduc --no-owner /tmp/restore.dump
docker compose exec -T postgres rm -f /tmp/restore.dump

echo "==> restarting api/worker..."
docker compose start api worker || true

echo
echo "restore complete from ${SNAP_FILE}."
echo "if ENCRYPTION_KEY in .env has changed since the snapshot was taken,"
echo "the bind secret will fail to decrypt and you'll need to re-run the setup wizard."

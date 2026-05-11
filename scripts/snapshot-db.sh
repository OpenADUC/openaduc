#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Snapshot the openaduc postgres database to ./snapshots/<name>.dump.
# Use this before switching to a different AD provider so you can roll back.
#
# Usage:
#   scripts/snapshot-db.sh                 # name defaults to "test-ad"
#   scripts/snapshot-db.sh prod-baseline
set -euo pipefail

NAME="${1:-test-ad}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_DIR="${REPO_ROOT}/snapshots"
SNAP_FILE="${SNAP_DIR}/${NAME}.dump"

mkdir -p "${SNAP_DIR}"

if [[ -f "${SNAP_FILE}" ]]; then
  read -r -p "snapshots/${NAME}.dump exists. Overwrite? [y/N] " ans
  [[ "${ans}" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi

cd "${REPO_ROOT}"

echo "==> dumping openaduc DB inside postgres container..."
docker compose exec -T postgres pg_dump -U openaduc -d openaduc -Fc -f /tmp/snap.dump

echo "==> copying dump out to ${SNAP_FILE}..."
docker compose cp postgres:/tmp/snap.dump "${SNAP_FILE}"
docker compose exec -T postgres rm -f /tmp/snap.dump

SIZE=$(du -h "${SNAP_FILE}" | cut -f1)
echo
echo "snapshot saved: ${SNAP_FILE} (${SIZE})"
echo
echo "NOTE: the encrypted bind secret in this dump is only restorable while"
echo "ENCRYPTION_KEY in .env stays the same. Do not rotate it between"
echo "snapshot and restore."

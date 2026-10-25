// SPDX-License-Identifier: BUSL-1.1
import { createHash } from 'node:crypto';

/**
 * Names a previewed change of these users, whatever their order or case,
 * so the job can check it runs on what the operator previewed. `kind`
 * says which change, `change` what it does (its arrays already in a
 * stable order). Not a secret: it guards against a stale preview, not a
 * forged one.
 */
export function previewToken(kind: string, ids: readonly string[], change: unknown): string {
  const users = ids
    .map((id) => id.toLowerCase())
    .sort()
    .join(',');
  return createHash('sha256')
    .update(`${kind}\n${users}\n${JSON.stringify(change)}`)
    .digest('base64url');
}

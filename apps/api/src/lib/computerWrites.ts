// SPDX-License-Identifier: BUSL-1.1
import type { ComputerWriteBlock } from '@openaduc/shared';
import { rawFlag } from './rawAttributes.js';

const SERVER_TRUST_ACCOUNT = 0x2000;
const PARTIAL_SECRETS_ACCOUNT = 0x04000000;

/**
 * Why this computer must not be disabled, reset or moved, or null when it
 * may be. Doing any of those to a domain controller can take the domain
 * down. Shared by the routes (reading the live entry or the cache) and the
 * provider (re-checking on the operator's bind right before writing).
 */
export function computerWriteBlock(raw: Record<string, unknown>): ComputerWriteBlock | null {
  const v = raw['userAccountControl'];
  const uac = Number.parseInt(String(Array.isArray(v) ? v[v.length - 1] : (v ?? 0)), 10) || 0;
  if (uac & SERVER_TRUST_ACCOUNT) return 'domain_controller';
  if (uac & PARTIAL_SECRETS_ACCOUNT) return 'read_only_domain_controller';
  if (rawFlag(raw['isCriticalSystemObject'])) return 'critical_system_object';
  return null;
}

export function describeComputerWriteBlock(reason: ComputerWriteBlock): string {
  switch (reason) {
    case 'domain_controller':
      return 'this is a domain controller';
    case 'read_only_domain_controller':
      return 'this is a read-only domain controller';
    case 'critical_system_object':
      return 'AD marks this computer as a critical system object';
  }
}

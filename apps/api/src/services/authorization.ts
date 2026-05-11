// SPDX-License-Identifier: BUSL-1.1
import { type Capability, ROLE_CAPABILITIES, type Role } from '@openaduc/shared';
import type { Env } from '../config/env.js';
import type { SettingsService } from './settings.js';

// Group DN comparisons are case-insensitive (RFC 4514). We don't normalize
// other forms (escaping, whitespace) — operators configure exact DNs as they
// appear in AD. Add canonicalization if it bites in the field.

interface RoleAssignmentConfig {
  /** AD group DN whose members get this role. null = role unassigned. */
  groupDn: string | null;
  role: Role;
}

export class AuthorizationService {
  constructor(
    private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Resolve the effective capability set for a user given their AD group DNs.
   * Returns an empty array if the user matches no configured role group AND
   * is not in the bootstrap admin group.
   */
  async resolveCapabilities(memberOfDns: readonly string[]): Promise<Capability[]> {
    const groups = memberOfDns.map((dn) => dn.toLowerCase());
    const assignments = await this.loadAssignments();

    const matchedRoles = new Set<Role>();
    for (const a of assignments) {
      if (!a.groupDn) continue;
      if (groups.includes(a.groupDn.toLowerCase())) {
        matchedRoles.add(a.role);
      }
    }
    // Bootstrap fallback: if no admin group is configured in settings, treat
    // BOOTSTRAP_ADMIN_GROUP_DN env as the admin group. This lets a fresh
    // deployment log in before any in-app config exists.
    const adminAssigned = assignments.find((a) => a.role === 'admin')?.groupDn;
    if (!adminAssigned && this.env.BOOTSTRAP_ADMIN_GROUP_DN) {
      const bootstrap = this.env.BOOTSTRAP_ADMIN_GROUP_DN.toLowerCase();
      if (groups.includes(bootstrap)) matchedRoles.add('admin');
    }

    const caps = new Set<Capability>();
    for (const role of matchedRoles) {
      for (const cap of ROLE_CAPABILITIES[role]) caps.add(cap);
    }
    return Array.from(caps);
  }

  /**
   * Pure helper used by route guards. Does not hit the DB; works against the
   * already-resolved capability snapshot stored on the session.
   */
  has(capabilities: readonly string[], required: Capability): boolean {
    return capabilities.includes(required);
  }

  hasAny(capabilities: readonly string[], required: readonly Capability[]): boolean {
    return required.some((c) => capabilities.includes(c));
  }

  private async loadAssignments(): Promise<RoleAssignmentConfig[]> {
    const [admin, operator, auditor] = await Promise.all([
      this.settings.get<string | null>('authz.admin_group_dn', null),
      this.settings.get<string | null>('authz.operator_group_dn', null),
      this.settings.get<string | null>('authz.auditor_group_dn', null),
    ]);
    return [
      { groupDn: admin, role: 'admin' },
      { groupDn: operator, role: 'operator' },
      { groupDn: auditor, role: 'auditor' },
    ];
  }
}

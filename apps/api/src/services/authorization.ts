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
    const groups = new Set(memberOfDns.map((dn) => dn.toLowerCase()));
    const matchedRoles = new Set<Role>();
    for (const g of await this.roleGroups()) {
      if (groups.has(g.dn.toLowerCase())) matchedRoles.add(g.role);
    }
    const caps = new Set<Capability>();
    for (const role of matchedRoles) {
      for (const cap of ROLE_CAPABILITIES[role]) caps.add(cap);
    }
    return Array.from(caps);
  }

  /**
   * The AD groups that grant an OpenADUC role. Bootstrap fallback: if no
   * admin group is configured in settings, BOOTSTRAP_ADMIN_GROUP_DN is the
   * admin group, so a fresh deployment can sign in before any in-app
   * config exists.
   */
  async roleGroups(): Promise<{ dn: string; role: Role }[]> {
    const assignments = await this.loadAssignments();
    const out = assignments.flatMap((a) => (a.groupDn ? [{ dn: a.groupDn, role: a.role }] : []));
    if (!out.some((g) => g.role === 'admin') && this.env.BOOTSTRAP_ADMIN_GROUP_DN) {
      out.push({ dn: this.env.BOOTSTRAP_ADMIN_GROUP_DN, role: 'admin' });
    }
    return out;
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

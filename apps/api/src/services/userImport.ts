// SPDX-License-Identifier: BUSL-1.1
// Importing users: the final check, judging an import against the
// directory right before the run, and the placement rules that remember
// where each bucket went.
import {
  NOTHING_TAKEN,
  addressConflicts,
  bucketKey,
  checkPassword,
  existingPerson,
  isDnWithin,
  parseDn,
  phonesToWrite,
  resolveNames,
  ruleKey,
  type CheckedImportRequest,
  type ImportCheckIssue,
  type ImportCheckResponse,
  type PlacementRule,
  type PlacementRuleInput,
} from '@openaduc/shared';
import type { Kysely, Selectable } from 'kysely';
import type { DB, ImportPlacementRulesTable } from '../db/types.js';
import { groupPrivilege, type RoleGroup } from '../lib/groupPrivilege.js';
import type { DirectoryProvider } from '../providers/types.js';
import type { DirectoryProviderSummary } from './directoryConfig.js';
import { findCachedGroupsById } from './groupCache.js';
import { membershipRequirement } from './groupMembershipWrite.js';
import { directoryUpnSuffixes } from './upnSuffixes.js';
import type { ImportPlan } from './bulkJobs/importRows.js';
import { cachedUserName, findCachedUser } from './userCache.js';

const lower = (v: string) => v.toLowerCase();
const localPart = (address: string) => address.slice(0, address.lastIndexOf('@'));
const goes = (n: number) => (n === 1 ? '1 row goes' : `${n} rows go`);

export interface ImportCheckDeps {
  db: Kysely<DB>;
  provider: DirectoryProvider;
  directory: DirectoryProviderSummary;
  roleGroups: readonly RoleGroup[];
  /** The operator may add members to a role group (`configure:security`). */
  canGrantRoles: boolean;
}

/**
 * The final check: the import as the run would make it, against the
 * directory as it is now. Each name exactly as it'll be written, against
 * the other rows and AD; anyone holding a row's employee ID or email by
 * now; each OU, group and manager still there, found in one search.
 */
export async function checkImport(
  deps: ImportCheckDeps,
  body: CheckedImportRequest,
): Promise<ImportCheckResponse> {
  const { db, provider, directory } = deps;
  const problems: ImportCheckIssue[] = [];
  const warnings: ImportCheckIssue[] = [];
  const problem = (row: number | null, kind: ImportCheckIssue['kind'], message: string) =>
    problems.push({ row, kind, message });
  const rows = body.rows;
  const lineOf = (i: number) => rows[i]!.line;

  // The names as typed, by the naming pattern's rules; one held by an
  // earlier row is taken by it.
  const judged = resolveNames(
    rows.map((r) => ({
      name: { first: r.givenName, last: r.surname },
      overrides: {
        samAccountName: r.samAccountName,
        userPrincipalName: r.userPrincipalName,
        displayName: r.displayName,
      },
    })),
    directory.naming,
    NOTHING_TAKEN,
    await directoryUpnSuffixes(provider, directory.domain),
  );
  judged.forEach((s, i) => {
    for (const d of s.deviations) {
      if (d.approval === 'blocked')
        problem(i, d.kind === 'taken' ? 'duplicate' : 'unusable', d.reason);
    }
  });
  const cnHolders = new Set<string>();
  rows.forEach((r, i) => {
    const key = `${lower(r.ouDn)}\n${lower(r.cn)}`;
    if (cnHolders.has(key))
      problem(i, 'duplicate', `Another row is named “${r.cn}” in the same OU.`);
    cnHolders.add(key);
  });

  const taken = await provider.findTakenNames({
    samAccountNamePrefixes: rows.map((r) => r.samAccountName),
    upnLocalPrefixes: [...new Set(rows.map((r) => localPart(r.userPrincipalName)))],
    cns: rows.map((r) => ({ ouDn: r.ouDn, cn: r.cn })),
    cnPrefixes: [],
  });
  const held = (values: Iterable<string>) => {
    const set = new Set(Array.from(values, lower));
    return (v: string) => set.has(lower(v));
  };
  const samHeld = held(taken.samAccountNames);
  const upnHeld = held([...taken.userPrincipalNames, ...taken.mailAddresses]);
  const cnHeld = held(Array.from(taken.cns, (c) => `${lower(c.ouDn)}\n${c.cn}`));
  rows.forEach((r, i) => {
    const inUse = (what: string, value: string) =>
      problem(i, 'taken', `The ${what} “${value}” is now used in the directory.`);
    if (samHeld(r.samAccountName)) inUse('sAMAccountName', r.samAccountName);
    if (upnHeld(r.userPrincipalName)) inUse('UPN', r.userPrincipalName);
    if (cnHeld(`${lower(r.ouDn)}\n${r.cn}`)) problem(i, 'taken', `“${r.cn}” now exists in its OU.`);
  });

  // The people holding a row's employee ID or email, and the emails
  // against each other and the UPNs, as the review checked them.
  const people = await provider.findPeople({
    employeeIds: [...new Set(rows.flatMap((r) => (r.employeeId ? [r.employeeId] : [])))],
    identifiers: [...new Set(rows.flatMap((r) => (r.email ? [r.email] : [])))],
  });
  const existing = rows.map((r) =>
    existingPerson({ employeeId: r.employeeId ?? '', email: r.email ?? '' }, people),
  );
  existing.forEach((match, i) => {
    if (!match) return;
    const name = match.person.displayName ?? match.person.samAccountName ?? 'someone';
    problem(
      i,
      'existing',
      `${name}, already in the directory, has the ${match.by === 'employeeId' ? 'employee ID' : 'email'} “${match.value}”.`,
    );
  });
  const conflicts = addressConflicts(
    rows.map((r, index) => ({
      index,
      email: r.email ?? null,
      upn: r.userPrincipalName,
      samAccountName: r.samAccountName,
    })),
    people,
    lineOf,
  );
  for (const [i, messages] of conflicts) {
    if (existing[i]) continue;
    for (const m of messages) problem(i, 'taken', m);
  }

  const ous = new Map<string, { dn: string; count: number }>();
  for (const r of rows) {
    const entry = ous.get(lower(r.ouDn)) ?? { dn: r.ouDn, count: 0 };
    entry.count++;
    ous.set(lower(r.ouDn), entry);
  }
  const groupIds = [...new Set(rows.flatMap((r) => (r.groups ?? []).map(lower)))];
  const managerIds = [
    ...new Set(
      rows.flatMap((r) => (r.organisation?.managerId ? [lower(r.organisation.managerId)] : [])),
    ),
  ];
  const searchable = [...ous.values()].filter(
    ({ dn }) => parseDn(dn) !== null && isDnWithin(dn, directory.baseDn),
  );
  const found = await provider.findObjects({
    dns: searchable.map((o) => o.dn),
    guids: [...groupIds, ...managerIds],
  });
  const liveDns = new Map(found.map((o) => [lower(o.distinguishedName), o]));
  const liveIds = new Set(found.map((o) => lower(o.objectGuid)));

  for (const { dn, count } of ous.values()) {
    const ou = liveDns.get(lower(dn));
    if (!ou?.isOu) {
      problem(null, 'ou_missing', `The OU “${dn}” no longer exists (${goes(count)} there).`);
    }
  }

  const cached = await findCachedGroupsById(db, provider.id, groupIds);
  const protectedGroups: ImportCheckResponse['protectedGroups'] = [];
  for (const id of groupIds) {
    const group = cached.get(id);
    if (!group || !liveIds.has(id)) {
      problem(null, 'group_missing', `The group “${group?.name ?? id}” no longer exists.`);
      continue;
    }
    if (groupPrivilege(group, deps.roleGroups)?.reason === 'protected') {
      protectedGroups.push({ id: group.id, name: group.name });
    }
    const needs = membershipRequirement('add', [group], deps.roleGroups);
    if (needs && !deps.canGrantRoles) problem(null, 'role_group', needs.reason);
  }

  for (const id of managerIds) {
    if (liveIds.has(id)) continue;
    const user = await findCachedUser(db, provider.id, { id });
    const name = user ? cachedUserName(user, id) : id;
    rows.forEach((r, i) => {
      if (r.organisation?.managerId && lower(r.organisation.managerId) === id) {
        warnings.push({
          row: i,
          kind: 'manager_missing',
          message: `The manager ${name} is no longer in the directory, so the account gets no manager.`,
        });
      }
    });
  }

  if (body.password.mode === 'set') {
    const policy = await provider.getDomainPolicy().catch(() => null);
    const password = body.password.password;
    const unmet = checkPassword(password, policy, {
      samAccountName: null,
      displayName: null,
    }).filter((c) => !c.met);
    if (unmet.length > 0) {
      problem(
        null,
        'password',
        `The password doesn’t meet the policy: ${unmet.map((c) => c.text.toLowerCase()).join('; ')}.`,
      );
    } else {
      rows.forEach((r, i) => {
        const own = checkPassword(password, policy, {
          samAccountName: r.samAccountName,
          displayName: r.displayName,
        });
        if (own.some((c) => !c.met)) {
          problem(i, 'password', `The password holds ${r.displayName}’s logon or display name.`);
        }
      });
    }
  }
  rows.forEach((r, i) => {
    const phones = phonesToWrite(r, r.keepPhonesAsTyped ?? [], directory.newUsers.phoneCountry);
    for (const p of phones.problems) problem(i, 'phone', p.message);
  });

  return { checkedAt: new Date().toISOString(), problems, warnings, protectedGroups };
}

/**
 * The checked import as its job runs it: each row's attributes as they'll
 * be written (mail from the UPN when asked, phones in Entra's form or as
 * typed), its manager and groups by id. With `checkLicenses`, the job
 * also checks in Entra the licenses its groups grant.
 */
export function importPlan(
  body: CheckedImportRequest,
  phoneCountry: string | null,
  { checkLicenses = false }: { checkLicenses?: boolean } = {},
): ImportPlan {
  return {
    password: body.password,
    enabled: body.enabled,
    ...(body.classTap ? { classTap: body.classTap } : {}),
    ...(checkLicenses ? { checkLicenses } : {}),
    rows: body.rows.map((r) => {
      const phones = phonesToWrite(r, r.keepPhonesAsTyped ?? [], phoneCountry).values;
      return {
        line: r.line,
        ouDn: r.ouDn,
        cn: r.cn,
        samAccountName: r.samAccountName,
        userPrincipalName: r.userPrincipalName,
        givenName: r.givenName,
        surname: r.surname,
        displayName: r.displayName,
        initials: r.initials,
        mail: r.email ?? (body.mailFromUpn ? r.userPrincipalName : null),
        otherMailbox: r.personalEmail ?? null,
        mobile: phones.mobile,
        telephoneNumber: phones.telephoneNumber,
        employeeId: r.employeeId,
        description: r.description,
        organisation: r.organisation?.attributes ?? {},
        managerId: r.organisation?.managerId ? lower(r.organisation.managerId) : null,
        managerRow: r.managerRow ?? null,
        groupIds: (r.groups ?? []).map(lower),
        usageLocation: r.usageLocation?.toUpperCase() ?? null,
        startDate: r.startDate ?? null,
      };
    }),
  };
}

// ---- Placement rules ------------------------------------------------------

type StoredRule = Selectable<ImportPlacementRulesTable>;

export async function loadPlacementRules(
  db: Kysely<DB>,
  providerId: number,
): Promise<PlacementRule[]> {
  const stored = await db
    .selectFrom('import_placement_rules')
    .selectAll()
    .where('provider_id', '=', providerId)
    .orderBy('grouping_column')
    .orderBy('value_key')
    .execute();
  const groups = await findCachedGroupsById(db, providerId, [
    ...new Set(stored.flatMap((r) => r.group_ids)),
  ]);
  return stored.map((r) => ({
    column: r.grouping_column,
    value: r.value,
    ouDn: r.ou_dn,
    groups: r.group_ids.flatMap((id) => {
      const g = groups.get(lower(id));
      return g ? [{ id: g.id, name: g.name }] : [];
    }),
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  }));
}

export interface PlacementRuleChange {
  before: Pick<StoredRule, 'grouping_column' | 'value' | 'ou_dn' | 'group_ids'> | null;
  after: PlacementRuleInput;
}

/**
 * Add or change each rule, one per column and value (the last given
 * wins); one already as asked is left alone. Returns what changed.
 */
export async function savePlacementRules(
  db: Kysely<DB>,
  providerId: number,
  rules: readonly PlacementRuleInput[],
  updatedBy: string | null,
): Promise<PlacementRuleChange[]> {
  const wanted = new Map(rules.map((r) => [ruleKey(r.column, r.value), r]));
  return db.transaction().execute(async (trx) => {
    const stored = await trx
      .selectFrom('import_placement_rules')
      .selectAll()
      .where('provider_id', '=', providerId)
      .forUpdate()
      .execute();
    const current = new Map(stored.map((r) => [ruleKey(r.grouping_column, r.value_key), r]));
    const changes: PlacementRuleChange[] = [];
    for (const [key, rule] of wanted) {
      const before = current.get(key) ?? null;
      const same =
        before !== null &&
        before.ou_dn === rule.ouDn &&
        before.group_ids.length === rule.groupIds.length &&
        before.group_ids.every((id) => rule.groupIds.some((g) => lower(g) === lower(id)));
      if (same) continue;
      const row = {
        value: rule.value,
        ou_dn: rule.ouDn,
        group_ids: JSON.stringify(rule.groupIds),
        updated_by: updatedBy,
        updated_at: new Date(),
      };
      if (before) {
        await trx
          .updateTable('import_placement_rules')
          .set(row)
          .where('id', '=', before.id)
          .execute();
      } else {
        await trx
          .insertInto('import_placement_rules')
          .values({
            ...row,
            provider_id: providerId,
            grouping_column: rule.column,
            value_key: bucketKey(rule.value),
          })
          .execute();
      }
      changes.push({ before, after: rule });
    }
    return changes;
  });
}

// SPDX-License-Identifier: BUSL-1.1
import {
  NOTHING_TAKEN,
  bucketKey,
  checkPassword,
  existingPerson,
  importLookupRequestSchema,
  importRequestSchema,
  isDnWithin,
  parseDn,
  phonesToWrite,
  placementRulesSaveSchema,
  resolveNames,
  type ImportCheckIssue,
  type ImportCheckResponse,
  type ImportLookupResponse,
  type ImportPerson,
  type PlacementRule,
  type PlacementRuleInput,
  type PlacementRulesResponse,
  type PlacementRulesSaveResponse,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { groupPrivilege } from '../lib/groupPrivilege.js';
import { BadRequest, NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { findCachedGroupsById, type CachedGroup } from '../services/groupCache.js';
import { membershipRequirement } from '../services/groupMembershipWrite.js';
import { directoryUpnSuffixes } from '../services/upnSuffixes.js';
import { cachedUserName, findCachedUser } from '../services/userCache.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const lower = (v: string) => v.toLowerCase();
const localPart = (address: string) => address.slice(0, address.lastIndexOf('@'));
const rows = (n: number) => (n === 1 ? '1 row goes' : `${n} rows go`);

// Importing users from a spreadsheet. The wizard keeps its draft in the
// browser; the server only answers lookups, stores the placement rules,
// and runs the final check right before the run.
export async function registerUserImportRoutes(app: FastifyInstance): Promise<void> {
  async function directoryOf(req: FastifyRequest) {
    const { id } = idParamSchema.parse(req.params);
    const directory = await app.services.directoryConfig.getById(id);
    if (!directory) throw NotFound('directory not found');
    return directory;
  }

  async function placementRules(providerId: number): Promise<PlacementRule[]> {
    const stored = await app.db
      .selectFrom('import_placement_rules')
      .selectAll()
      .where('provider_id', '=', providerId)
      .orderBy('grouping_column')
      .orderBy('value_key')
      .execute();
    const groups = await findCachedGroupsById(app.db, providerId, [
      ...new Set(stored.flatMap((r) => r.group_ids)),
    ]);
    return stored.map((r) => ({
      column: r.grouping_column,
      value: r.value,
      ouDn: r.ou_dn,
      groups: r.group_ids.flatMap((id) => {
        const g = groups.get(id.toLowerCase());
        return g ? [{ id: g.id, name: g.name }] : [];
      }),
      updatedAt: r.updated_at.toISOString(),
      updatedBy: r.updated_by,
    }));
  }

  // ---- GET /api/directories/:id/placement-rules ------------------------
  // Where earlier imports put each bucket, to prefill the next one.
  app.get('/api/directories/:id/placement-rules', {
    config: { policy: { capability: 'write:user.create', stepUp: false, directory: 'param' } },
    handler: async (req): Promise<PlacementRulesResponse> => {
      const directory = await directoryOf(req);
      return { rules: await placementRules(directory.id) };
    },
  });

  // ---- PUT /api/directories/:id/placement-rules ------------------------
  // Remembers where each bucket of an import goes. Each rule added or
  // changed is audited with what it was and what it is now; one that's
  // already as asked is left alone.
  app.put('/api/directories/:id/placement-rules', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'param' } },
    handler: async (req): Promise<PlacementRulesSaveResponse> => {
      const directory = await directoryOf(req);
      const body = placementRulesSaveSchema.parse(req.body);
      const byKey = new Map<string, PlacementRuleInput>();
      for (const rule of body.rules) byKey.set(`${rule.column}\n${bucketKey(rule.value)}`, rule);
      const wanted = [...byKey.values()];

      const groupIds = [...new Set(wanted.flatMap((r) => r.groupIds.map(lower)))];
      if (groupIds.length > 0) await app.requireCapability(req, 'write:group.membership');
      const groups = await findCachedGroupsById(app.db, directory.id, groupIds);
      const unknown = groupIds.find((id) => !groups.has(id));
      if (unknown) throw BadRequest(`group ${unknown} not found in directory cache`);
      for (const { ouDn } of wanted) {
        if (!parseDn(ouDn)) throw BadRequest(`"${ouDn}" isn't a distinguished name.`);
        if (!isDnWithin(ouDn, directory.baseDn)) {
          throw BadRequest(`"${ouDn}" isn't under this directory's base DN.`);
        }
      }

      const actor = req.actor!.session.actorUsername;
      const changes = await app.db.transaction().execute(async (trx) => {
        const stored = await trx
          .selectFrom('import_placement_rules')
          .selectAll()
          .where('provider_id', '=', directory.id)
          .forUpdate()
          .execute();
        const current = new Map(stored.map((r) => [`${r.grouping_column}\n${r.value_key}`, r]));
        const out: { before: (typeof stored)[number] | null; after: PlacementRuleInput }[] = [];
        for (const rule of wanted) {
          const key = bucketKey(rule.value);
          const before = current.get(`${rule.column}\n${key}`) ?? null;
          const ids = rule.groupIds.map((id) => groups.get(lower(id))!.id);
          const same =
            before !== null &&
            before.ou_dn === rule.ouDn &&
            before.group_ids.length === ids.length &&
            before.group_ids.every((id) => ids.some((g) => lower(g) === lower(id)));
          if (same) continue;
          const row = {
            value: rule.value,
            ou_dn: rule.ouDn,
            group_ids: JSON.stringify(ids),
            updated_by: actor,
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
                provider_id: directory.id,
                grouping_column: rule.column,
                value_key: key,
              })
              .execute();
          }
          out.push({ before, after: { ...rule, groupIds: ids } });
        }
        return out;
      });

      const names = await findCachedGroupsById(app.db, directory.id, [
        ...new Set([...groupIds, ...changes.flatMap((c) => c.before?.group_ids ?? [])]),
      ]);
      const named = (ids: readonly string[]) =>
        ids.map((id) => ({ id, name: names.get(lower(id))?.name ?? null }));
      for (const { before, after } of changes) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: before ? 'import.placementRule.update' : 'import.placementRule.create',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: directory.id,
            targetType: 'config',
            targetId: String(directory.id),
            before: before && {
              column: before.grouping_column,
              value: before.value,
              ouDn: before.ou_dn,
              groups: named(before.group_ids),
            },
            after: {
              column: after.column,
              value: after.value,
              ouDn: after.ouDn,
              groups: named(after.groupIds),
            },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for import.placementRule'));
      }
      return { rules: await placementRules(directory.id), changed: changes.length };
    },
  });

  // ---- POST /api/users/import/lookup ------------------------------------
  // A read sent as POST: who in the directory holds an import's employee
  // IDs, emails and manager values, asked of AD rather than the cache so
  // someone added since the last sync isn't created twice.
  app.post('/api/users/import/lookup', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<ImportLookupResponse> => {
      const body = importLookupRequestSchema.parse(req.body);
      if (body.employeeIds.length + body.identifiers.length === 0) return { people: [] };
      const provider = await app.services.providers.buildForRequest(req);
      const found = await provider.findPeople(body);
      return {
        people: found.map((p) => ({
          id: p.objectGuid,
          distinguishedName: p.distinguishedName,
          samAccountName: p.samAccountName,
          userPrincipalName: p.userPrincipalName,
          displayName: p.displayName,
          employeeId: p.employeeId,
          addresses: p.addresses,
        })),
      };
    },
  });

  // ---- POST /api/users/import/check -------------------------------------
  // The final check, right before the run: the import as the run would
  // make it, against the directory as it is now. Each name must still be
  // free and each OU, group and manager still there. Nothing is written,
  // but it's the run's gate, so it takes what the run takes.
  app.post('/api/users/import/check', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<ImportCheckResponse> => {
      const body = importRequestSchema.parse(req.body);
      const groupIds = [...new Set(body.rows.flatMap((r) => (r.groups ?? []).map(lower)))];
      if (groupIds.length > 0) await app.requireCapability(req, 'write:group.membership');
      const provider = await app.services.providers.buildForRequest(req);
      const directory = await app.services.directoryConfig.getById(provider.id);
      if (!directory) throw NotFound('directory not found');

      const problems: ImportCheckIssue[] = [];
      const warnings: ImportCheckIssue[] = [];
      const problem = (row: number | null, kind: ImportCheckIssue['kind'], message: string) =>
        problems.push({ row, kind, message });
      const mailOf = (r: (typeof body.rows)[number]) =>
        r.email ?? (body.mailFromUpn ? r.userPrincipalName : null);

      // The names as typed, by the naming pattern's rules; one held by an
      // earlier row of the import is taken by it.
      const judged = resolveNames(
        body.rows.map((r) => ({
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
          if (d.approval === 'blocked') {
            problem(i, d.kind === 'taken' ? 'duplicate' : 'unusable', d.reason);
          }
        }
      });
      const addressHolders = new Map<string, number>();
      const cnHolders = new Map<string, number>();
      body.rows.forEach((r, i) => {
        const mail = r.email;
        if (mail) {
          const other = addressHolders.get(lower(mail));
          if (other !== undefined && other !== i) {
            problem(i, 'duplicate', `The email “${mail}” is another row’s too.`);
          }
        }
        for (const a of [r.userPrincipalName, mail]) {
          if (a && !addressHolders.has(lower(a))) addressHolders.set(lower(a), i);
        }
        const cnKey = `${lower(r.ouDn)}\n${lower(r.cn)}`;
        if (cnHolders.has(cnKey)) {
          problem(i, 'duplicate', `Another row is named “${r.cn}” in the same OU.`);
        } else cnHolders.set(cnKey, i);
      });

      // Each name against the directory, exactly.
      const taken = await provider.findTakenNames({
        samAccountNamePrefixes: body.rows.map((r) => r.samAccountName),
        upnLocalPrefixes: [
          ...new Set(
            body.rows.flatMap((r) => [
              localPart(r.userPrincipalName),
              ...(r.email ? [localPart(r.email)] : []),
            ]),
          ),
        ],
        cns: body.rows.map((r) => ({ ouDn: r.ouDn, cn: r.cn })),
        cnPrefixes: [],
      });
      const held = (values: Iterable<string>) => {
        const set = new Set(Array.from(values, lower));
        return (v: string) => set.has(lower(v));
      };
      const samHeld = held(taken.samAccountNames);
      const upnHeld = held(taken.userPrincipalNames);
      const mailHeld = held(taken.mailAddresses);
      const cnHeld = held(Array.from(taken.cns, (c) => `${lower(c.ouDn)}\n${c.cn}`));
      body.rows.forEach((r, i) => {
        const inUse = (what: string, value: string) =>
          problem(i, 'taken', `The ${what} “${value}” is now used in the directory.`);
        if (samHeld(r.samAccountName)) inUse('sAMAccountName', r.samAccountName);
        if (upnHeld(r.userPrincipalName) || mailHeld(r.userPrincipalName)) {
          inUse('UPN', r.userPrincipalName);
        }
        const mail = mailOf(r);
        if (
          mail &&
          lower(mail) !== lower(r.userPrincipalName) &&
          (mailHeld(mail) || upnHeld(mail))
        ) {
          inUse('email', mail);
        }
        if (cnHeld(`${lower(r.ouDn)}\n${r.cn}`)) {
          problem(i, 'taken', `“${r.cn}” now exists in its OU.`);
        }
      });

      // Someone created since the review.
      const people = await provider.findPeople({
        employeeIds: [...new Set(body.rows.flatMap((r) => (r.employeeId ? [r.employeeId] : [])))],
        identifiers: [
          ...new Set(body.rows.flatMap((r) => (!r.employeeId && r.email ? [r.email] : []))),
        ],
      });
      const asPeople: ImportPerson[] = people.map((p) => ({ ...p, id: p.objectGuid }));
      body.rows.forEach((r, i) => {
        const match = existingPerson(
          { employeeId: r.employeeId ?? '', email: r.email ?? '' },
          asPeople,
        );
        if (match) {
          const name = match.person.displayName ?? match.person.samAccountName ?? 'someone';
          problem(
            i,
            'existing',
            match.by === 'employeeId'
              ? `${name}, already in the directory, has the employee ID “${match.value}”.`
              : `${name}, already in the directory, has the email “${match.value}”.`,
          );
        }
      });

      // The OUs, groups and managers, still there.
      const ouRows = new Map<string, { dn: string; count: number }>();
      for (const r of body.rows) {
        const entry = ouRows.get(lower(r.ouDn)) ?? { dn: r.ouDn, count: 0 };
        entry.count++;
        ouRows.set(lower(r.ouDn), entry);
      }
      for (const { dn, count } of ouRows.values()) {
        if (!parseDn(dn) || !isDnWithin(dn, directory.baseDn)) {
          problem(
            null,
            'ou_missing',
            `“${dn}” isn’t an OU in this directory (${rows(count)} there).`,
          );
          continue;
        }
        const ou = await provider.findObject({ kind: 'distinguishedName', value: dn });
        if (!ou?.isOu) {
          problem(null, 'ou_missing', `The OU “${dn}” no longer exists (${rows(count)} there).`);
        }
      }

      const cached = await findCachedGroupsById(app.db, provider.id, groupIds);
      const roleGroups = await app.services.authorization.roleGroups();
      const canGrantRoles = app.services.authorization.has(
        req.actor!.session.capabilities,
        'configure:security',
      );
      const protectedGroups: ImportCheckResponse['protectedGroups'] = [];
      for (const id of groupIds) {
        const group: CachedGroup | undefined = cached.get(id);
        const live = await provider.findObject({ kind: 'objectGuid', value: id });
        if (!live || !group) {
          problem(
            null,
            'group_missing',
            `The group “${group?.name ?? live?.name ?? id}” no longer exists.`,
          );
          continue;
        }
        const privilege = groupPrivilege(group, roleGroups);
        if (privilege?.reason === 'protected')
          protectedGroups.push({ id: group.id, name: group.name });
        const needs = membershipRequirement('add', [group], roleGroups);
        if (needs && !canGrantRoles) problem(null, 'role_group', needs.reason);
      }

      const managerIds = [
        ...new Set(
          body.rows.flatMap((r) => (r.organisation?.managerId ? [r.organisation.managerId] : [])),
        ),
      ];
      for (const id of managerIds) {
        if (await provider.findObject({ kind: 'objectGuid', value: id })) continue;
        const user = await findCachedUser(app.db, provider.id, { id });
        const name = user ? cachedUserName(user, id) : id;
        body.rows.forEach((r, i) => {
          if (r.organisation?.managerId === id) {
            warnings.push({
              row: i,
              kind: 'manager_missing',
              message: `The manager ${name} is no longer in the directory, so the account gets no manager.`,
            });
          }
        });
      }

      // What each row writes, as the create would refuse it.
      if (body.password.mode === 'set') {
        const policy = await provider.getDomainPolicy().catch(() => null);
        const password = body.password.password;
        const everyone = checkPassword(password, policy, {
          samAccountName: null,
          displayName: null,
        });
        const unmet = everyone.filter((c) => !c.met);
        if (unmet.length > 0) {
          problem(
            null,
            'password',
            `The password doesn’t meet the policy: ${unmet.map((c) => c.text.toLowerCase()).join('; ')}.`,
          );
        } else {
          body.rows.forEach((r, i) => {
            const own = checkPassword(password, policy, {
              samAccountName: r.samAccountName,
              displayName: r.displayName,
            });
            if (own.some((c) => !c.met)) {
              problem(
                i,
                'password',
                `The password holds ${r.displayName}’s logon or display name.`,
              );
            }
          });
        }
      }
      body.rows.forEach((r, i) => {
        const phones = phonesToWrite(r, r.keepPhonesAsTyped ?? [], directory.newUsers.phoneCountry);
        for (const p of phones.problems) problem(i, 'phone', p.message);
      });

      return { checkedAt: new Date().toISOString(), problems, warnings, protectedGroups };
    },
  });
}

// SPDX-License-Identifier: BUSL-1.1
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  BULK_ATTRIBUTE_FIELDS,
  directoryCountry,
  PREVIEW_LIST_LIMIT,
  type BulkAttributeChange,
  type BulkAttributeChanges,
  type BulkAttributeField,
  type BulkAttributesPreviewUser,
  type BulkAttributeValue,
  type BulkGroupPreviewUser,
  type BulkUserAttributesPreview,
  type DirectoryCountry,
} from '@openaduc/shared';
import type { DB, UserCacheRecordsTable } from '../db/types.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import type { DirectoryUser, UserAttributePatch } from '../providers/types.js';
import { BulkJobRequestError } from './bulkJobs/errors.js';
import { findCachedUser } from './userCache.js';

/** The fields that are one string attribute each, named as the attribute. */
const TEXT_FIELDS = [
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
  'description',
  'streetAddress',
  'postOfficeBox',
  'l',
  'st',
  'postalCode',
] as const satisfies readonly BulkAttributeField[];
type TextField = (typeof TEXT_FIELDS)[number];

type Country = { [K in keyof DirectoryCountry]: string | null };

/** A user's values for the fields a bulk edit changes, from the cache or read live. */
export type AttributeValues = Record<TextField, string | null> & {
  managerDn: string | null;
  country: Country;
};

/**
 * What a bulk edit sets each field it names to (null clears it), with the
 * manager and country resolved to what AD stores. A job's rows keep this.
 */
export type ResolvedChanges = Partial<Record<TextField, string | null>> & {
  manager?: { dn: string; name: string } | null;
  country?: DirectoryCountry | null;
};

const NO_COUNTRY: Country = { c: null, co: null, countryCode: null };

function text(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function country(c: unknown, co: unknown, countryCode: unknown): Country {
  const code = text(rawScalarValue(countryCode));
  // AD writes 0 for no country.
  return {
    c: text(rawScalarValue(c)),
    co: text(rawScalarValue(co)),
    countryCode: code === '0' ? null : code,
  };
}

const sameCountry = (a: Country, b: Country): boolean =>
  a.c === b.c && a.co === b.co && a.countryCode === b.countryCode;

/** The user's values as just read from the directory. */
export function liveValues(user: DirectoryUser): AttributeValues {
  const raw = user.rawAttributes;
  const fromRaw = (name: string) => text(rawScalarValue(raw[name]));
  return {
    title: text(user.title),
    department: text(user.department),
    company: fromRaw('company'),
    physicalDeliveryOfficeName: text(user.office),
    description: fromRaw('description'),
    streetAddress: fromRaw('streetAddress'),
    postOfficeBox: fromRaw('postOfficeBox'),
    l: fromRaw('l'),
    st: fromRaw('st'),
    postalCode: fromRaw('postalCode'),
    managerDn: text(user.managerDn),
    country: country(raw['c'], raw['co'], raw['countryCode']),
  };
}

type CachedUser = Pick<
  Selectable<UserCacheRecordsTable>,
  'title' | 'department' | 'manager_dn' | 'raw_attributes_json'
>;

/** The user's values as the cache last saw them. */
export function cachedValues(user: CachedUser): AttributeValues {
  const raw = user.raw_attributes_json;
  const fromRaw = (name: string) => text(rawScalarValue(raw[name]));
  return {
    title: text(user.title),
    department: text(user.department),
    company: fromRaw('company'),
    physicalDeliveryOfficeName: fromRaw('physicalDeliveryOfficeName'),
    description: fromRaw('description'),
    streetAddress: fromRaw('streetAddress'),
    postOfficeBox: fromRaw('postOfficeBox'),
    l: fromRaw('l'),
    st: fromRaw('st'),
    postalCode: fromRaw('postalCode'),
    managerDn: text(user.manager_dn),
    country: country(raw['c'], raw['co'], raw['countryCode']),
  };
}

/** One field's change to one user, in what AD stores. */
type FieldChange =
  | { field: TextField; before: string | null; after: string | null }
  | { field: 'manager'; before: string | null; after: string | null }
  | { field: 'country'; before: Country; after: Country };

/**
 * The fields `changes` would change for a user with these values, in
 * field order; a field already as asked isn't one of them.
 */
export function fieldChanges(values: AttributeValues, changes: ResolvedChanges): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of BULK_ATTRIBUTE_FIELDS) {
    if (changes[field] === undefined) continue;
    if (field === 'manager') {
      const after = changes.manager?.dn ?? null;
      const before = values.managerDn;
      if (before?.toLowerCase() !== after?.toLowerCase()) out.push({ field, before, after });
    } else if (field === 'country') {
      const after = changes.country ?? NO_COUNTRY;
      if (!sameCountry(values.country, after)) {
        out.push({ field, before: values.country, after });
      }
    } else {
      const after = changes[field] ?? null;
      if (values[field] !== after) out.push({ field, before: values[field], after });
    }
  }
  return out;
}

/** The provider patch that makes these changes. */
export function patchFor(changes: readonly FieldChange[]): UserAttributePatch {
  const patch: UserAttributePatch = {};
  for (const change of changes) {
    if (change.field === 'manager') patch.managerDn = change.after;
    else if (change.field === 'country') {
      patch.c = change.after.c;
      patch.co = change.after.co;
      // As ADUC does when the country is set to none.
      patch.countryCode = change.after.countryCode ?? '0';
    } else patch[change.field] = change.after;
  }
  return patch;
}

/** A row's before and after, by attribute, for the job to keep. */
export function rowSnapshots(changes: readonly FieldChange[]): {
  before: Record<string, string | null>;
  after: Record<string, string | null>;
} {
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const change of changes) {
    if (change.field === 'manager') {
      before['managerDn'] = change.before;
      after['managerDn'] = change.after;
    } else if (change.field === 'country') {
      Object.assign(before, change.before);
      Object.assign(after, change.after);
    } else {
      before[change.field] = change.before;
      after[change.field] = change.after;
    }
  }
  return { before, after };
}

/**
 * Names this edit of these users, whatever their order or case, so the
 * job can check it runs on what the operator previewed. Not a secret: it
 * guards against a stale preview, not a forged one.
 */
export function attributesPreviewToken(
  ids: readonly string[],
  changes: BulkAttributeChanges,
): string {
  const users = [...ids.map((id) => id.toLowerCase())].sort().join(',');
  const fields = BULK_ATTRIBUTE_FIELDS.filter((f) => changes[f] !== undefined).map((f) => [
    f,
    f === 'manager' ? (changes.manager?.toLowerCase() ?? null) : (changes[f] ?? null),
  ]);
  return createHash('sha256')
    .update(`attributes\n${users}\n${JSON.stringify(fields)}`)
    .digest('base64url');
}

/**
 * The edit with its manager and country as AD stores them. Refuses a
 * manager the cache doesn't know, or one among the users edited (they'd
 * be their own manager).
 */
export async function resolveChanges(
  db: Kysely<DB>,
  providerId: number,
  ids: readonly string[],
  changes: BulkAttributeChanges,
): Promise<ResolvedChanges> {
  const { manager, country: code, ...texts } = changes;
  const resolved: ResolvedChanges = {};
  for (const field of TEXT_FIELDS) {
    const value = texts[field];
    if (value !== undefined) resolved[field] = value;
  }
  if (manager !== undefined) {
    if (manager === null) resolved.manager = null;
    else {
      const id = manager.toLowerCase();
      if (ids.some((u) => u.toLowerCase() === id)) {
        throw new BulkJobRequestError(
          'manager_in_selection',
          'The manager is one of the users edited, and can’t be their own manager. Leave them out, or pick another manager.',
        );
      }
      const found = await findCachedUser(db, providerId, { id });
      if (!found) throw new BulkJobRequestError('manager_not_found', 'manager not found');
      resolved.manager = {
        dn: found.distinguished_name,
        name: found.display_name ?? found.sam_account_name ?? found.distinguished_name,
      };
    }
  }
  if (code !== undefined) resolved.country = code === null ? null : directoryCountry(code);
  return resolved;
}

/** What the job's audit entry and progress say it sets each field to. */
export function changesSubject(
  changes: ResolvedChanges,
): { field: BulkAttributeField; value: string | null }[] {
  return BULK_ATTRIBUTE_FIELDS.filter((f) => changes[f] !== undefined).map((field) => ({
    field,
    value:
      field === 'manager'
        ? (changes.manager?.name ?? null)
        : field === 'country'
          ? (changes.country?.co ?? null)
          : (changes[field] ?? null),
  }));
}

/** Users counted in full, and listed up to the preview's limit (they come sorted by name). */
function listed<T>() {
  const list = { count: 0, users: [] as T[] };
  return {
    list,
    add(user: T): void {
      list.count++;
      if (list.users.length < PREVIEW_LIST_LIMIT) list.users.push(user);
    },
  };
}

/**
 * What editing these users would change, read from the cache before
 * anything is written, with each field's current values across them.
 */
export async function previewAttributes(
  db: Kysely<DB>,
  providerId: number,
  request: { ids: string[]; changes: BulkAttributeChanges },
): Promise<BulkUserAttributesPreview> {
  const ids = request.ids.map((id) => id.toLowerCase());
  const changes = await resolveChanges(db, providerId, ids, request.changes);
  const users = await db
    .selectFrom('user_cache_records')
    .select([
      'object_guid',
      'display_name',
      'sam_account_name',
      'title',
      'department',
      'manager_dn',
      'raw_attributes_json',
    ])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`object_guid = ANY(${ids}::uuid[])`)
    .execute();
  const known = users
    .map((u) => ({
      id: u.object_guid.toLowerCase(),
      name: u.display_name ?? u.sam_account_name ?? u.object_guid,
      values: cachedValues(u),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const managerDns = new Set(known.flatMap((u) => u.values.managerDn ?? []));
  if (changes.manager) managerDns.add(changes.manager.dn);
  const managerNames = await namesByDn(db, providerId, [...managerDns]);
  const managerName = (dn: string | null) =>
    dn === null ? null : (managerNames.get(dn.toLowerCase()) ?? dn);
  const countryName = (c: Country) => c.co ?? c.c;

  const changed = listed<BulkAttributesPreviewUser>();
  const unchanged = listed<BulkGroupPreviewUser>();
  const perField = new Map<BulkAttributeField, number>();
  for (const user of known) {
    const list = fieldChanges(user.values, changes);
    if (list.length === 0) {
      unchanged.add({ id: user.id, name: user.name });
      continue;
    }
    for (const c of list) perField.set(c.field, (perField.get(c.field) ?? 0) + 1);
    changed.add({
      id: user.id,
      name: user.name,
      changes: list.map((c): BulkAttributeChange =>
        c.field === 'country'
          ? { field: c.field, before: countryName(c.before), after: countryName(c.after) }
          : c.field === 'manager'
            ? { field: c.field, before: managerName(c.before), after: managerName(c.after) }
            : c,
      ),
    });
  }

  const current = Object.fromEntries(
    BULK_ATTRIBUTE_FIELDS.map((field) => {
      const shown = new Map<string, string | null>();
      for (const { values } of known) {
        const [key, display] =
          field === 'manager'
            ? [values.managerDn?.toLowerCase() ?? '', managerName(values.managerDn)]
            : field === 'country'
              ? [JSON.stringify(values.country), countryName(values.country)]
              : [values[field] ?? '', values[field]];
        shown.set(key, display);
      }
      const value: BulkAttributeValue =
        shown.size > 1
          ? { kind: 'multiple', count: shown.size }
          : { kind: 'same', value: [...shown.values()][0] ?? null };
      return [field, value];
    }),
  ) as Record<BulkAttributeField, BulkAttributeValue>;

  const knownIds = new Set(known.map((u) => u.id));
  return {
    current,
    changed: changed.list,
    unchanged: unchanged.list,
    fields: BULK_ATTRIBUTE_FIELDS.filter((f) => changes[f] !== undefined).map((field) => ({
      field,
      count: perField.get(field) ?? 0,
    })),
    unknownCount: ids.filter((id) => !knownIds.has(id)).length,
    previewToken: attributesPreviewToken(request.ids, request.changes),
  };
}

/** Cached users' display names by lowercased DN. */
async function namesByDn(
  db: Kysely<DB>,
  providerId: number,
  dns: string[],
): Promise<Map<string, string>> {
  if (dns.length === 0) return new Map();
  const rows = await db
    .selectFrom('user_cache_records')
    .select(['distinguished_name', 'display_name', 'sam_account_name'])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(
      sql<string>`lower(distinguished_name)`,
      'in',
      dns.map((dn) => dn.toLowerCase()),
    )
    .execute();
  return new Map(
    rows.map((r) => [
      r.distinguished_name.toLowerCase(),
      r.display_name ?? r.sam_account_name ?? r.distinguished_name,
    ]),
  );
}

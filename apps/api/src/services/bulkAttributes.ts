// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  BULK_ATTRIBUTE_FIELDS,
  directoryCountry,
  type BulkAttributeChanges,
  type BulkAttributeField,
  type BulkAttributesPreviewUser,
  type BulkAttributeValue,
  type BulkUserAttributesPreview,
  type PreviewUser,
} from '@openaduc/shared';
import type { DB, UserCacheRecordsTable } from '../db/types.js';
import { rawArrayValues, rawScalarValue } from '../lib/rawAttributes.js';
import type { DirectoryUser, UserAttributePatch } from '../providers/types.js';
import { BulkJobRequestError } from './bulkJobs/errors.js';
import { previewList } from './previewList.js';
import { previewToken } from './previewToken.js';
import { cachedUserName, findCachedUser } from './userCache.js';
import { SELF_MANAGER_MESSAGE } from './userAttributeWrite.js';

/** A country as compared and written: by code and number; the name goes along. */
interface Country {
  c: string | null;
  co: string | null;
  countryCode: string | null;
}

/** Each field's value, as compared: the manager by DN, the PO boxes sorted. */
interface FieldValues {
  title: string | null;
  department: string | null;
  company: string | null;
  physicalDeliveryOfficeName: string | null;
  manager: string | null;
  description: string | null;
  streetAddress: string | null;
  postOfficeBox: string[];
  l: string | null;
  st: string | null;
  postalCode: string | null;
  country: Country;
}

/** A user's values; a field the cache hasn't read for them is missing. */
export type AttributeValues = Partial<FieldValues>;

/** What a bulk edit sets each field it names to (null or [] clears it), as AD stores it. */
export type ResolvedChanges = Partial<FieldValues> & {
  /** The manager's name, for the preview and the job's subject. */
  managerName?: string;
};

type CachedUser = Pick<
  Selectable<UserCacheRecordsTable>,
  'title' | 'department' | 'manager_dn' | 'office' | 'office_read' | 'raw_attributes_json'
>;

/** How one field is read, compared, written and shown. */
interface Field<V> {
  live(user: DirectoryUser): V;
  /** Undefined when the cache hasn't read it. */
  cached(user: CachedUser): V | undefined;
  same(a: V, b: V): boolean;
  patch(value: V): UserAttributePatch;
  /** By attribute, as the job's row keeps it. */
  snapshot(value: V): Record<string, unknown>;
  display(value: V, managerName: (dn: string) => string): string | null;
}

const text = (v: unknown): string | null => {
  const t = rawScalarValue(v)?.trim();
  return t ? t : null;
};

const COUNTRY_NONE = '0';

/** A single-valued string attribute, read live from `live` and from the cache's `cached`. */
function textField(
  attribute: Exclude<keyof UserAttributePatch, 'otherMailbox' | 'otherHomePhone' | 'otherMobile'>,
  live: (user: DirectoryUser) => unknown = (u) => u.rawAttributes[attribute],
  cached: (user: CachedUser) => unknown = (u) => u.raw_attributes_json[attribute],
): Field<string | null> {
  return {
    live: (user) => text(live(user)),
    cached: (user) => text(cached(user)),
    same: (a, b) => a === b,
    patch: (value) => ({ [attribute]: value }),
    snapshot: (value) => ({ [attribute]: value }),
    display: (value) => value,
  };
}

function country(c: unknown, co: unknown, countryCode: unknown): Country {
  const code = text(countryCode);
  return { c: text(c), co: text(co), countryCode: code === COUNTRY_NONE ? null : code };
}

const poBoxes = (v: unknown): string[] =>
  rawArrayValues(v)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .sort();

const FIELDS: { [F in BulkAttributeField]: Field<FieldValues[F]> } = {
  title: textField(
    'title',
    (u) => u.title,
    (u) => u.title,
  ),
  department: textField(
    'department',
    (u) => u.department,
    (u) => u.department,
  ),
  company: textField('company'),
  physicalDeliveryOfficeName: {
    ...textField('physicalDeliveryOfficeName', (u) => u.office),
    cached: (u) => (u.office_read ? text(u.office) : undefined),
  },
  manager: {
    live: (u) => text(u.managerDn),
    cached: (u) => text(u.manager_dn),
    same: (a, b) => a?.toLowerCase() === b?.toLowerCase(),
    patch: (dn) => ({ managerDn: dn }),
    snapshot: (dn) => ({ managerDn: dn }),
    display: (dn, managerName) => (dn === null ? null : managerName(dn)),
  },
  description: textField('description'),
  streetAddress: textField('streetAddress'),
  postOfficeBox: {
    live: (u) => poBoxes(u.rawAttributes['postOfficeBox']),
    cached: (u) => poBoxes(u.raw_attributes_json['postOfficeBox']),
    same: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    patch: (values) => ({ postOfficeBox: values.length > 0 ? values : null }),
    snapshot: (values) => ({ postOfficeBox: values }),
    display: (values) => (values.length > 0 ? values.join(', ') : null),
  },
  l: textField('l'),
  st: textField('st'),
  postalCode: textField('postalCode'),
  country: {
    live: (u) =>
      country(u.rawAttributes['c'], u.rawAttributes['co'], u.rawAttributes['countryCode']),
    cached: (u) =>
      country(
        u.raw_attributes_json['c'],
        u.raw_attributes_json['co'],
        u.raw_attributes_json['countryCode'],
      ),
    // The name isn't compared: ADUC and other tools spell it differently.
    same: (a, b) => a.c === b.c && a.countryCode === b.countryCode,
    patch: (v) => ({ c: v.c, co: v.co, countryCode: v.countryCode ?? COUNTRY_NONE }),
    snapshot: (v) => ({ c: v.c, co: v.co, countryCode: v.countryCode ?? COUNTRY_NONE }),
    display: (v) => v.co ?? v.c,
  },
};

// The table's fields, typed loosely so they can be walked in one loop.
const field = (f: BulkAttributeField) => FIELDS[f] as Field<unknown>;
const named = (changes: object) =>
  BULK_ATTRIBUTE_FIELDS.filter((f) => (changes as Record<string, unknown>)[f] !== undefined);

/** The user's values as just read from the directory. */
export function liveValues(user: DirectoryUser): AttributeValues {
  return Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, field(f).live(user)]));
}

/** The user's values as the cache last saw them. */
export function cachedValues(user: CachedUser): AttributeValues {
  return Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, field(f).cached(user)]));
}

export interface FieldChange {
  field: BulkAttributeField;
  before: unknown;
  after: unknown;
}

/**
 * The fields `changes` would change for a user with these values, in
 * field order, and those it names that aren't known for the user.
 */
export function fieldChanges(
  values: AttributeValues,
  changes: ResolvedChanges,
): { changes: FieldChange[]; unread: BulkAttributeField[] } {
  const out: FieldChange[] = [];
  const unread: BulkAttributeField[] = [];
  for (const f of named(changes)) {
    const before = values[f];
    const after = changes[f];
    if (before === undefined) unread.push(f);
    else if (!field(f).same(before, after)) out.push({ field: f, before, after });
  }
  return { changes: out, unread };
}

/** The provider patch that makes these changes. */
export function patchFor(changes: readonly FieldChange[]): UserAttributePatch {
  return Object.assign({}, ...changes.map((c) => field(c.field).patch(c.after)));
}

/** A row's before and after, by attribute, for the job to keep. */
export function rowSnapshots(changes: readonly FieldChange[]): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} {
  return {
    before: Object.assign({}, ...changes.map((c) => field(c.field).snapshot(c.before))),
    after: Object.assign({}, ...changes.map((c) => field(c.field).snapshot(c.after))),
  };
}

export function attributesPreviewToken(
  ids: readonly string[],
  changes: BulkAttributeChanges,
): string {
  const fields = named(changes).map((f) => {
    const value = changes[f];
    return [f, f === 'manager' && typeof value === 'string' ? value.toLowerCase() : value];
  });
  return previewToken('attributes', ids, fields);
}

/**
 * The edit as AD stores it: the manager by DN, the country as its three
 * attributes. Refuses a manager the cache doesn't know.
 */
export async function resolveChanges(
  db: Kysely<DB>,
  providerId: number,
  changes: BulkAttributeChanges,
): Promise<ResolvedChanges> {
  const { manager, country: code, postOfficeBox, ...texts } = changes;
  const resolved: ResolvedChanges = {};
  for (const [f, value] of Object.entries(texts)) {
    if (value !== undefined) (resolved as Record<string, unknown>)[f] = value;
  }
  if (postOfficeBox !== undefined) resolved.postOfficeBox = [...(postOfficeBox ?? [])].sort();
  if (code !== undefined) {
    const found = code === null ? null : directoryCountry(code);
    resolved.country = found ?? { c: null, co: null, countryCode: null };
  }
  if (manager === null) resolved.manager = null;
  else if (manager !== undefined) {
    const found = await findCachedUser(db, providerId, { id: manager.toLowerCase() });
    if (!found) throw new BulkJobRequestError('manager_not_found', 'manager not found');
    resolved.manager = found.distinguished_name;
    resolved.managerName = cachedUserName(found, found.distinguished_name);
  }
  return resolved;
}

/** Whether this user is the edit's new manager, which would make them their own. */
export const ownManager = (userDn: string, changes: ResolvedChanges): boolean =>
  !!changes.manager && changes.manager.toLowerCase() === userDn.toLowerCase();

/** What the job's audit entry and progress say it sets each field to. */
export function changesSubject(
  changes: ResolvedChanges,
): { field: BulkAttributeField; value: string | null }[] {
  return named(changes).map((f) => ({
    field: f,
    value: field(f).display(changes[f], () => changes.managerName ?? ''),
  }));
}

/**
 * What editing these users would change, read from the cache before
 * anything is written, with each field's current values across them.
 * `offset` and `limit` page through the users it changes.
 */
export async function previewAttributes(
  db: Kysely<DB>,
  providerId: number,
  request: { ids: string[]; changes: BulkAttributeChanges; offset: number; limit: number },
): Promise<BulkUserAttributesPreview> {
  const ids = request.ids.map((id) => id.toLowerCase());
  const changes = await resolveChanges(db, providerId, request.changes);
  const rows = await db
    .selectFrom('user_cache_records')
    .select([
      'object_guid',
      'distinguished_name',
      'display_name',
      'sam_account_name',
      'title',
      'department',
      'manager_dn',
      'office',
      'office_read',
      'raw_attributes_json',
    ])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`object_guid = ANY(${ids}::uuid[])`)
    .execute();
  const known = rows
    .map((u) => ({
      id: u.object_guid.toLowerCase(),
      dn: u.distinguished_name,
      name: cachedUserName(u, u.object_guid),
      values: cachedValues(u),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const managerDns = new Set(known.flatMap((u) => u.values.manager ?? []));
  const names = await namesByDn(db, providerId, [...managerDns]);
  if (changes.manager && changes.managerName) {
    names.set(changes.manager.toLowerCase(), changes.managerName);
  }
  const managerName = (dn: string) => names.get(dn.toLowerCase()) ?? dn;
  const shown = (f: BulkAttributeField, v: unknown) => field(f).display(v, managerName);

  const changed = previewList<BulkAttributesPreviewUser>(request.offset, request.limit);
  const unchanged = previewList();
  const unread = previewList();
  const skipped = previewList<PreviewUser & { reason: string }>();
  const perField = new Map(named(changes).map((f) => [f, { count: 0, unread: 0 }]));
  for (const user of known) {
    const entry = { id: user.id, name: user.name };
    if (ownManager(user.dn, changes)) {
      skipped.add({ ...entry, reason: SELF_MANAGER_MESSAGE });
      continue;
    }
    const found = fieldChanges(user.values, changes);
    for (const f of found.unread) perField.get(f)!.unread++;
    for (const c of found.changes) perField.get(c.field)!.count++;
    if (found.changes.length > 0) {
      changed.add({
        ...entry,
        changes: found.changes.map((c) => ({
          field: c.field,
          before: shown(c.field, c.before),
          after: shown(c.field, c.after),
        })),
      });
    } else if (found.unread.length > 0) unread.add(entry);
    else unchanged.add(entry);
  }

  const current = Object.fromEntries(
    BULK_ATTRIBUTE_FIELDS.map((f): [BulkAttributeField, BulkAttributeValue] => {
      const values: unknown[] = [];
      for (const { values: v } of known) {
        if (v[f] !== undefined && !values.some((seen) => field(f).same(seen, v[f]))) {
          values.push(v[f]);
        }
      }
      if (values.length > 1) return [f, { kind: 'multiple', count: values.length }];
      if (known.some((u) => u.values[f] === undefined)) return [f, { kind: 'unknown' }];
      return [f, { kind: 'same', value: values.length ? shown(f, values[0]) : null }];
    }),
  ) as BulkUserAttributesPreview['current'];

  const knownIds = new Set(known.map((u) => u.id));
  return {
    current,
    changed: { ...changed.list, offset: request.offset },
    unchanged: unchanged.list,
    unread: unread.list,
    skipped: skipped.list,
    fields: [...perField].map(([f, counts]) => ({ field: f, ...counts })),
    unknownCount: ids.filter((id) => !knownIds.has(id)).length,
    previewToken: attributesPreviewToken(request.ids, request.changes),
  };
}

/** Cached users' names by lowercased DN. */
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
    rows.map((r) => [r.distinguished_name.toLowerCase(), cachedUserName(r, r.distinguished_name)]),
  );
}

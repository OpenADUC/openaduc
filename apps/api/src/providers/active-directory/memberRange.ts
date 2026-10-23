// SPDX-License-Identifier: BUSL-1.1
import type { Client, Entry } from 'ldapts';

// `member;range=0-1499`, or `member;range=1500-*` for the last range.
const RANGED_MEMBER = /^member;range=(\d+)-(\d+|\*)$/i;

const valuesOf = (v: Entry[string] | undefined): string[] =>
  v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String);

/**
 * AD hands out at most MaxValRange values (1500 by default) of a
 * multi-valued attribute per read: past that, a group comes back with
 * `member;range=0-1499` instead of `member`. Read the rest a range at a
 * time, until AD marks the last range's end with `*`, and put the whole
 * list under `member`. Entries without a ranged `member` come back as they
 * were.
 */
export async function withAllMembers(client: Pick<Client, 'search'>, entry: Entry): Promise<Entry> {
  let key = Object.keys(entry).find((k) => RANGED_MEMBER.test(k));
  if (!key) return entry;
  const members = valuesOf(entry[key]);
  delete entry[key];
  let end = RANGED_MEMBER.exec(key)![2]!;
  while (end !== '*') {
    const start = Number(end) + 1;
    const { searchEntries } = await client.search(entry.dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [`member;range=${start}-*`],
    });
    const page = searchEntries[0];
    key = page && Object.keys(page).find((k) => RANGED_MEMBER.test(k));
    if (!page || !key) break;
    members.push(...valuesOf(page[key]));
    const next = RANGED_MEMBER.exec(key)![2]!;
    // A range that doesn't move forward would loop for ever.
    if (next !== '*' && Number(next) < start) break;
    end = next;
  }
  entry.member = members;
  return entry;
}

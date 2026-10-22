// SPDX-License-Identifier: BUSL-1.1
import { type RawBuilder, sql } from 'kysely';

// "Not one of these" as a single array parameter. `NOT IN (…)` binds one
// parameter per value, and Postgres refuses more than 65,535, so a full
// crawl of a large directory failed at its stale-marking step.

/** `column` (a uuid) is not in `ids`. */
export function uuidNotIn(column: string, ids: Iterable<string>): RawBuilder<boolean> {
  return sql<boolean>`${sql.ref(column)} <> ALL(${Array.from(ids)}::uuid[])`;
}

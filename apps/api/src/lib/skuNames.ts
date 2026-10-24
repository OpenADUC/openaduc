// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import { parseTable } from '@openaduc/shared';

// Licence products by the names Microsoft's admin centers show, from a
// trimmed copy of Microsoft's "Product names and service plan identifiers
// for licensing" list vendored at apps/api/data/sku-names.csv
// (scripts/refresh-sku-names.mjs refreshes it). The same relative path
// resolves from src/lib and dist/lib alike.

const SOURCE = new URL('../../data/sku-names.csv', import.meta.url);

let names: Map<string, string> | null = null;

function load(): Map<string, string> {
  const map = new Map<string, string>();
  let table;
  try {
    table = parseTable(readFileSync(SOURCE, 'utf8'));
  } catch {
    // Without the list every product shows by its part number.
    return map;
  }
  const guid = table.header.indexOf('GUID');
  const name = table.header.indexOf('Product_Display_Name');
  for (const row of table.rows) {
    if (row[guid] && row[name]) map.set(row[guid].toLowerCase(), row[name]);
  }
  return map;
}

/** A product's friendly name, else its part number, else its id. */
export function skuName(skuId: string, skuPartNumber: string | null): string {
  names ??= load();
  return names.get(skuId.toLowerCase()) ?? skuPartNumber ?? skuId;
}

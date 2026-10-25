// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import { parseTable, type LicenseSku } from '@openaduc/shared';

// License products by the names Microsoft's admin centers show, from a
// trimmed copy of Microsoft's "Product names and service plan identifiers
// for licensing" list vendored at apps/api/data/sku-names.csv
// (apps/api/scripts/refresh-sku-names.ts refreshes it). The same relative
// path resolves from src/lib and dist/lib alike.

const SOURCE = new URL('../../data/sku-names.csv', import.meta.url);

let names: Map<string, string> | null = null;

/** Product names by SKU id, from a copy of the list; empty, with a warning, when it can't be read. */
export function readSkuNames(source: URL): Map<string, string> {
  const map = new Map<string, string>();
  let table;
  try {
    table = parseTable(readFileSync(source, 'utf8'));
  } catch (err) {
    // Every product then shows by its part number.
    console.warn(`license product names unavailable (${source.pathname}): ${String(err)}`);
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
  names ??= readSkuNames(SOURCE);
  return names.get(skuId.toLowerCase()) ?? skuPartNumber ?? skuId;
}

/** A product as pages show it, from its id and its part number if known. */
export function licenseSku(skuId: string, skuPartNumber: string | null): LicenseSku {
  return { skuId, skuPartNumber, name: skuName(skuId, skuPartNumber) };
}

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

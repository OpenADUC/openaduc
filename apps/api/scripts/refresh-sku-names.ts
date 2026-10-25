// SPDX-License-Identifier: BUSL-1.1
// Refresh the license product names OpenADUC shows instead of SKU part
// numbers ("Microsoft 365 E3", not SPE_E3).
//
// Downloads Microsoft's "Product names and service plan identifiers for
// licensing" CSV and keeps one row per SKU (its GUID, part number and
// product name), sorted by part number so a refresh diffs cleanly. The API
// reads the trimmed copy at runtime and never fetches it itself.
//
// Usage (after `pnpm --filter @openaduc/shared build`):
//   pnpm --filter @openaduc/api refresh-sku-names            # download and rewrite
//   pnpm --filter @openaduc/api refresh-sku-names file.csv   # trim a CSV already downloaded

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { csvRow, parseTable } from '@openaduc/shared';

const SOURCE =
  'https://download.microsoft.com/download/e/3/e/e3e9faf2-f28b-490a-9ada-c6089a1fc5b0/Product%20names%20and%20service%20plan%20identifiers%20for%20licensing.csv';
const TARGET = fileURLToPath(new URL('../data/sku-names.csv', import.meta.url));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const file = process.argv[2];
const text = file
  ? readFileSync(file, 'utf8')
  : await fetch(SOURCE).then((res) => {
      if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
      return res.text();
    });

const table = parseTable(text);
const col = (name: string) => {
  const i = table.header.indexOf(name);
  if (i < 0) throw new Error(`the CSV has no ${name} column; Microsoft may have changed it`);
  return i;
};
const [nameAt, partAt, guidAt] = [col('Product_Display_Name'), col('String_Id'), col('GUID')];

const skus = new Map<string, [string, string, string]>();
for (const row of table.rows) {
  const guid = row[guidAt]!.toLowerCase();
  const part = row[partAt]!;
  const name = row[nameAt]!.replace(/\s+/g, ' ');
  if (!GUID.test(guid) || !part || !name || skus.has(guid)) continue;
  skus.set(guid, [guid, part, name]);
}
if (skus.size < 100) throw new Error(`only ${skus.size} SKUs found; refusing to write`);

const lines = [...skus.values()]
  .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  .map((r) => csvRow(r));
const header = csvRow(['GUID', 'String_Id', 'Product_Display_Name']);
writeFileSync(TARGET, [header, ...lines, ''].join('\n'));
console.info(`wrote ${skus.size} SKUs to ${TARGET}`);

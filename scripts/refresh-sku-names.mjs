#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Refresh the licence product names OpenADUC shows instead of SKU part
// numbers ("Microsoft 365 E3", not SPE_E3).
//
// Downloads Microsoft's "Product names and service plan identifiers for
// licensing" CSV and keeps one row per SKU (its GUID, part number and
// product name), sorted by part number so a refresh diffs cleanly. The API
// reads the trimmed copy at runtime and never fetches it itself.
//
// Usage:
//   node scripts/refresh-sku-names.mjs            # download and rewrite
//   node scripts/refresh-sku-names.mjs file.csv   # trim a CSV already downloaded

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE =
  'https://download.microsoft.com/download/e/3/e/e3e9faf2-f28b-490a-9ada-c6089a1fc5b0/Product%20names%20and%20service%20plan%20identifiers%20for%20licensing.csv';
const TARGET = fileURLToPath(new URL('../apps/api/data/sku-names.csv', import.meta.url));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4180 records: quoted cells may hold commas, doubled quotes and line breaks. */
function records(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) out.push([...row, cell]);
  return out;
}

const cellOf = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

const text = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await fetch(SOURCE).then((res) => {
      if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
      return res.text();
    });

const [header, ...rows] = records(text.replace(/^﻿/, ''));
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`the CSV has no ${name} column; Microsoft may have changed it`);
  return i;
};
const [nameAt, partAt, guidAt] = [col('Product_Display_Name'), col('String_Id'), col('GUID')];

const skus = new Map();
for (const row of rows) {
  const guid = row[guidAt]?.trim().toLowerCase();
  const part = row[partAt]?.trim();
  const name = row[nameAt]?.trim().replace(/\s+/g, ' ');
  if (!guid || !GUID.test(guid) || !part || !name || skus.has(guid)) continue;
  skus.set(guid, [guid, part, name]);
}
if (skus.size < 100) throw new Error(`only ${skus.size} SKUs found; refusing to write`);

const lines = [...skus.values()]
  .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  .map((r) => r.map(cellOf).join(','));
writeFileSync(TARGET, ['GUID,String_Id,Product_Display_Name', ...lines, ''].join('\n'));
console.info(`wrote ${skus.size} SKUs to ${TARGET}`);

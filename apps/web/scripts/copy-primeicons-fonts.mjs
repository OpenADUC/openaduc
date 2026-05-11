// SPDX-License-Identifier: BUSL-1.1
//
// Post-build copy: PrimeIcons' bundled CSS references its font binaries with
// `url('./fonts/<name>.<ext>')`. When that CSS is pulled in via `@import` from
// our app stylesheet, postcss-import inlines its contents but does NOT rewrite
// those urls — they end up in the built CSS unchanged. Vite never sees them
// as assets, so the font files are never emitted to dist/.
//
// The references resolve relative to the built CSS at /assets/index-*.css,
// so the binaries need to land at dist/assets/fonts/. Copy them here.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'node_modules', 'primeicons', 'fonts');
const dst = resolve(here, '..', 'dist', 'assets', 'fonts');

if (!existsSync(src)) {
  console.error(`primeicons fonts not found at ${src} — did pnpm install run?`);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`Copied PrimeIcons fonts → ${dst}`);

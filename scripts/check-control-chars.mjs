#!/usr/bin/env node
// Fail if source files contain raw control characters (anything below 0x20
// except tab, LF and CR). A single raw NUL makes grep-style tools treat the
// whole file as binary and silently skip it, which hides code from anyone
// searching the repo. Write such characters as escapes (`\0`, `\x1b`).
//
// With file arguments (lint-staged) only those are checked; otherwise every
// tracked source file is.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SOURCE = /\.(ts|tsx|vue|js|mjs|cjs)$/;
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const files = (
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
).filter((f) => SOURCE.test(f));

let failed = false;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = CONTROL.exec(line);
    if (m) {
      const code = m[0].charCodeAt(0).toString(16).padStart(2, '0');
      console.error(`${file}:${i + 1}:${m.index + 1}: raw control character 0x${code}`);
      failed = true;
    }
  });
}
if (failed) {
  console.error('\nWrite control characters as escape sequences instead of raw bytes.');
  process.exit(1);
}

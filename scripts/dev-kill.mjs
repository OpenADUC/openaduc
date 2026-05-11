#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Dev-mode port reclaimer.
//
// Frees the ports the local dev servers want to bind to, in case a previous
// `pnpm dev` left an orphan process holding them. Tries SIGTERM first, falls
// back to SIGKILL after a short grace period.
//
// Usage:
//   node scripts/dev-kill.mjs            # both API + web
//   node scripts/dev-kill.mjs api        # API only (port from $API_PORT or 3000)
//   node scripts/dev-kill.mjs web        # web only (5173)
//   node scripts/dev-kill.mjs 3000 8080  # specific ports

import { execSync } from 'node:child_process';

const DEFAULT_API_PORT = Number(process.env.API_PORT ?? 3000);
const DEFAULT_WEB_PORT = 5173;

function pidsOnPort(port) {
  // `lsof -ti` prints just PIDs, one per line. `-sTCP:LISTEN` filters to
  // listening sockets so we don't kill outbound clients sharing the port.
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!out) return [];
    return out.split('\n').map((s) => Number(s)).filter(Number.isFinite);
  } catch {
    // lsof exits 1 when nothing matches.
    return [];
  }
}

function freePort(port) {
  const pids = pidsOnPort(port);
  if (pids.length === 0) {
    console.log(`port ${port}: nothing listening`);
    return;
  }
  console.log(`port ${port}: killing pid(s) ${pids.join(', ')}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.error(`  pid ${pid}: SIGTERM failed (${err.code ?? err.message})`);
      }
    }
  }
  // Brief grace period, then SIGKILL anything still holding the port.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (pidsOnPort(port).length === 0) return;
    // Spin-wait — total wait < 1.5s, no need for an event loop tick.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  for (const pid of pidsOnPort(port)) {
    console.log(`  pid ${pid}: still holding port, sending SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.error(`  pid ${pid}: SIGKILL failed (${err.code ?? err.message})`);
      }
    }
  }
}

const args = process.argv.slice(2);
const ports = [];
if (args.length === 0) {
  ports.push(DEFAULT_API_PORT, DEFAULT_WEB_PORT);
} else {
  for (const a of args) {
    if (a === 'api') ports.push(DEFAULT_API_PORT);
    else if (a === 'web') ports.push(DEFAULT_WEB_PORT);
    else {
      const n = Number(a);
      if (Number.isFinite(n)) ports.push(n);
      else console.error(`ignoring unrecognized arg: ${a}`);
    }
  }
}

for (const p of ports) freePort(p);

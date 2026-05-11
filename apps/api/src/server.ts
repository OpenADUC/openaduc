// SPDX-License-Identifier: BUSL-1.1
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

// Hard ceiling on graceful shutdown. If Fastify's onClose hooks (pg pool drain,
// in-flight LDAP, etc.) don't return within this window, force-exit so the
// dev-server respawn loop and CI don't hang. Tunable via env for production.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.API_SHUTDOWN_TIMEOUT_MS ?? 5_000);

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();

  let shuttingDown = false;
  const close = async (signal: string) => {
    if (shuttingDown) {
      // Second Ctrl+C — the operator wants out NOW. Skip the graceful path.
      app.log.warn({ signal }, 'second signal received, force-exiting');
      process.exit(130);
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    // Watchdog: if app.close() doesn't resolve in time, kill the process so
    // tsx watch / pnpm dev can rebind the port on restart.
    const watchdog = setTimeout(() => {
      app.log.error(
        { timeoutMs: SHUTDOWN_TIMEOUT_MS },
        'graceful shutdown exceeded timeout — force-exiting',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      await app.close();
      clearTimeout(watchdog);
      process.exit(0);
    } catch (err) {
      clearTimeout(watchdog);
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
  // SIGHUP fires when the controlling terminal goes away (e.g. tsx watch
  // killed, parent shell closed). Treat it the same as SIGTERM so we don't
  // linger holding the listen socket.
  process.on('SIGHUP', () => void close('SIGHUP'));

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (err) {
    // Surface EADDRINUSE with an actionable hint instead of a stack trace —
    // this is the most common dev-mode failure when a previous run left an
    // orphan node listening on the port.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${env.API_PORT} is already in use.\n` +
          `  An earlier API process is probably still alive — run \`pnpm dev:kill\` to free it,\n` +
          `  then restart \`pnpm dev\`.\n`,
      );
      process.exit(1);
    }
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();

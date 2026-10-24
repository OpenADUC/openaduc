// SPDX-License-Identifier: BUSL-1.1
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { buildLoggerOptions } from './logger.js';

function logged(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, done) {
      out += String(chunk);
      done();
    },
  });
  const options = buildLoggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'test' } as Env);
  pino(options, sink).info(obj, 'request');
  return out;
}

describe('logger redaction', () => {
  it.each([
    'password',
    'newPassword',
    'adminPassword',
    'bindPassword',
    'actorPassword',
    'elevatedPassword',
    'clientSecret',
    'temporaryAccessPass',
  ])('hides %s however deep it is', (key) => {
    const line = logged({ [key]: 'top', body: { [key]: 'one' }, req: { body: { [key]: 'two' } } });
    expect(line).not.toMatch(/"(top|one|two)"/);
  });
});

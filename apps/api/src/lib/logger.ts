// SPDX-License-Identifier: BUSL-1.1
import { pino, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

export function buildLoggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'password',
        '*.password',
        '*.*.password',
        'unicodePwd',
        '*.unicodePwd',
        'authorization',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'secret',
        '*.secret',
        'token',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
    base: {
      service: 'api',
      env: env.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (env.NODE_ENV === 'development') {
    base.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    };
  }

  return base;
}

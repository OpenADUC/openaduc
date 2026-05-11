// SPDX-License-Identifier: BUSL-1.1
import type { FastifyBaseLogger } from 'fastify';
import type { SyncTaskKey } from './types.js';

/**
 * Hooks for downstream notification channels (NTFY, email, webhook).
 * v1 ships a no-op dispatcher that only logs; future dispatchers
 * register against the same interface without scheduler changes.
 */
export type SyncEvent =
  | {
      kind: 'task.failed';
      providerId: number;
      taskKey: SyncTaskKey;
      error: string;
      consecutiveFailures: number;
      at: Date;
    }
  | {
      kind: 'task.failed_threshold';
      providerId: number;
      taskKey: SyncTaskKey;
      error: string;
      consecutiveFailures: number;
      threshold: number;
      at: Date;
    }
  | {
      kind: 'task.recovered';
      providerId: number;
      taskKey: SyncTaskKey;
      previousFailures: number;
      at: Date;
    };

export interface NotificationDispatcher {
  dispatch(event: SyncEvent): void | Promise<void>;
}

/**
 * Default dispatcher: log only. Replaced by the wiring layer once an
 * NTFY / email backend is configured.
 */
export class LoggingNotificationDispatcher implements NotificationDispatcher {
  constructor(private readonly log: FastifyBaseLogger) {}

  dispatch(event: SyncEvent): void {
    if (event.kind === 'task.failed_threshold') {
      this.log.warn(
        {
          providerId: event.providerId,
          taskKey: event.taskKey,
          consecutiveFailures: event.consecutiveFailures,
          threshold: event.threshold,
        },
        'sync task crossed failure threshold',
      );
    } else if (event.kind === 'task.recovered') {
      this.log.info(
        {
          providerId: event.providerId,
          taskKey: event.taskKey,
          previousFailures: event.previousFailures,
        },
        'sync task recovered',
      );
    }
    // task.failed below threshold: silent, the row already records it.
  }
}

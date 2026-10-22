// SPDX-License-Identifier: BUSL-1.1
// Every Postgres advisory lock OpenADUC takes, in one place so two features
// can't pick the same key by accident.

/** First-run setup: one setup at a time across every API process. */
export const SETUP_LOCK_KEY = 0x0add_5e7;

/**
 * Per-directory sync: first key of the two-key form (the second is the
 * directory id), so tasks for one directory never run in two processes.
 */
export const SYNC_LOCK_CLASS = 0x0ad0;

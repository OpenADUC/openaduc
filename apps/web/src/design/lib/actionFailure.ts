// SPDX-License-Identifier: BUSL-1.1

/** A write that failed, shown beside what failed until retried or dismissed. */
export interface ActionFailure {
  summary: string;
  message: string;
  retry: () => void;
  dismiss: () => void;
}

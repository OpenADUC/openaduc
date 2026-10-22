// SPDX-License-Identifier: BUSL-1.1

export interface BulkResult {
  succeeded: string[];
  failures: { id: string; error: string }[];
}

/**
 * Run `action` for each id in turn, so one failure doesn't stop the rest,
 * and say which ids succeeded and which failed (with why), so the caller can
 * keep the failures selected for a retry.
 */
export async function runBulk(
  ids: readonly string[],
  action: (id: string) => Promise<unknown>,
  onProgress?: (done: number) => void,
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failures: [] };
  for (const [i, id] of ids.entries()) {
    try {
      await action(id);
      result.succeeded.push(id);
    } catch (err) {
      result.failures.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
    onProgress?.(i + 1);
  }
  return result;
}

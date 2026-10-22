// SPDX-License-Identifier: BUSL-1.1

/**
 * Tracks which of several overlapping requests is the latest, so a slow
 * response for something the user has already navigated away from can be
 * dropped instead of overwriting what they're looking at now.
 *
 *   const guard = latestRequest();
 *   const isCurrent = guard.begin();
 *   const data = await fetch…;
 *   if (isCurrent()) record.value = data;
 */
export function latestRequest(): { begin(): () => boolean } {
  let latest = 0;
  return {
    begin() {
      const token = ++latest;
      return () => token === latest;
    },
  };
}

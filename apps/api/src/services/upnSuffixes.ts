// SPDX-License-Identifier: BUSL-1.1
import type { DirectoryProvider } from '../providers/types.js';

/** The UPN suffixes accounts can take: the domain's DNS name first, then the forest's extras. */
export async function directoryUpnSuffixes(
  provider: DirectoryProvider,
  domain: string,
): Promise<string[]> {
  const all = [domain, ...(await provider.getUpnSuffixes())].map((s) => s.toLowerCase());
  return [...new Set(all)];
}

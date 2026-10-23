// SPDX-License-Identifier: BUSL-1.1
// What's in the selected OU or container, for the OU browser and the Old
// School contents list. Only the latest selection's answer lands, so a slow
// OU can't replace the one the operator moved on to.

import { ref } from 'vue';
import type { OuContentsResponse } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { errorMessage } from '../lib/errorMessage.js';
import { latestRequest } from '../lib/latestRequest.js';

const empty = (): OuContentsResponse => ({
  users: [],
  groups: [],
  computers: [],
  linkedGroupPolicies: [],
  inheritedGroupPolicies: [],
});

export function useOuContents() {
  const contents = ref<OuContentsResponse>(empty());
  const loading = ref(false);
  const error = ref<string | null>(null);
  const requests = latestRequest();

  async function load(dn: string): Promise<void> {
    const isCurrent = requests.begin();
    loading.value = true;
    error.value = null;
    try {
      const loaded = await api.ous.contents(dn);
      if (isCurrent()) contents.value = loaded;
    } catch (err) {
      if (!isCurrent()) return;
      contents.value = empty();
      error.value = errorMessage(err, 'Failed to load OU contents');
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  function clear(): void {
    requests.begin();
    contents.value = empty();
    loading.value = false;
    error.value = null;
  }

  return { contents, loading, error, load, clear };
}

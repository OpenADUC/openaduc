// SPDX-License-Identifier: BUSL-1.1
// The directory's OUs, for the OU browser and the Old School console tree.
// A failed reload keeps the OUs already on screen.

import { ref } from 'vue';
import type { DirectoryOu } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { errorMessage } from '../lib/errorMessage.js';
import { latestRequest } from '../lib/latestRequest.js';

export function useOuTree() {
  const ous = ref<DirectoryOu[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const requests = latestRequest();

  async function load(): Promise<void> {
    const isCurrent = requests.begin();
    loading.value = true;
    error.value = null;
    try {
      const resp = await api.ous.list();
      if (isCurrent()) ous.value = resp.ous;
    } catch (err) {
      if (isCurrent()) error.value = errorMessage(err, 'Failed to load OUs');
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  return { ous, loading, error, load };
}

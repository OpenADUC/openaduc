// SPDX-License-Identifier: BUSL-1.1
// Loading one user, group or computer, for the detail pages and the Old
// School Properties dialogs.

import type { ComputerDetail, GroupDetail, UserDetail } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useDetailRecord, type DetailRecordOptions } from './useDetailRecord.js';

type RecordOptions<T> = Omit<DetailRecordOptions<T>, 'fetch' | 'notFoundMessage' | 'failedMessage'>;

export function useUserRecord(opts: RecordOptions<UserDetail>) {
  return useDetailRecord<UserDetail>({
    ...opts,
    fetch: async (id) => (await api.users.get(id)).user,
    notFoundMessage: 'User not found',
    failedMessage: 'Failed to load user',
  });
}

export function useGroupRecord(opts: RecordOptions<GroupDetail>) {
  return useDetailRecord<GroupDetail>({
    ...opts,
    fetch: async (id) => (await api.groups.get(id)).group,
    notFoundMessage: 'Group not found',
    failedMessage: 'Failed to load group',
  });
}

export function useComputerRecord(opts: RecordOptions<ComputerDetail>) {
  return useDetailRecord<ComputerDetail>({
    ...opts,
    fetch: async (id) => (await api.computers.get(id)).computer,
    notFoundMessage: 'Computer not found',
    failedMessage: 'Failed to load computer',
  });
}

// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';
import type { UserMatchCandidate, UserMatchResponse } from '@openaduc/shared';

const person = (id: string, over: Partial<UserMatchCandidate> = {}): UserMatchCandidate => ({
  id,
  samAccountName: id,
  userPrincipalName: `${id}@corp.example`,
  displayName: null,
  email: null,
  department: null,
  title: null,
  enabled: true,
  distinguishedName: `CN=${id},OU=Staff,DC=corp,DC=example`,
  ...over,
});

const response: UserMatchResponse = {
  results: [
    { entry: 'jdoe', status: 'matched', user: person('jdoe', { displayName: 'Jane Doe' }) },
    {
      entry: 'John Smith',
      status: 'ambiguous',
      candidates: [
        person('jsmith', { displayName: 'John Smith', department: 'Sales' }),
        person('jsmith2', {
          displayName: 'John Smith',
          department: 'Engineering',
          distinguishedName: 'CN=John Smith,OU=Leavers,DC=corp,DC=example',
        }),
      ],
    },
    { entry: 'nobody', status: 'unmatched' },
  ],
};
const match = vi.fn(async () => response);
vi.mock('../../api/index.js', () => ({ api: { users: { match } } }));

const { default: PasteListDialog } = await import('./PasteListDialog.vue');

const button = (w: ReturnType<typeof mount>, label: string) =>
  w.findAll('button').find((b) => b.text() === label);

describe('the paste a list dialog', () => {
  it('finds the pasted users, asks who an ambiguous entry means, and selects them', async () => {
    const dialog = mount(PasteListDialog, {
      props: { visible: true, selected: new Set(['someone-else']), isLoaded: () => true },
      global: { plugins: [PrimeVue], stubs: { teleport: true } },
    });
    await flushPromises();

    await dialog.get('textarea').setValue('jdoe\nJohn Smith\nnobody');
    await button(dialog, 'Find users')!.trigger('click');
    await flushPromises();

    expect(match).toHaveBeenCalledWith(['jdoe', 'John Smith', 'nobody']);
    expect(dialog.get('[role="status"]').text()).toBe(
      "1 user found from 3 entries. Pick who you mean for 1 entry below, or it'll be skipped.",
    );
    expect(dialog.text()).toContain('Engineering');
    expect(dialog.text()).toContain('corp.example/Leavers');
    expect(dialog.text()).toContain('No match (1)');

    const choice = dialog.findAll('fieldset label').find((l) => l.text().includes('Engineering'))!;
    await choice.get('input').setValue(true);
    expect(dialog.get('[role="status"]').text()).toBe('2 users found from 3 entries.');

    await button(dialog, 'Select 2 users')!.trigger('click');
    const [selected] = dialog.emitted<[Set<string>]>('update:selected')!.at(-1)!;
    expect([...selected]).toEqual(['jdoe', 'jsmith2']);
    expect(dialog.emitted('update:visible')!.at(-1)).toEqual([false]);
  });

  it('can add the users to what is already selected', async () => {
    const dialog = mount(PasteListDialog, {
      props: { visible: true, selected: new Set(['someone-else']), isLoaded: () => true },
      global: { plugins: [PrimeVue], stubs: { teleport: true } },
    });
    await flushPromises();
    await dialog.get('textarea').setValue('jdoe');
    await button(dialog, 'Find users')!.trigger('click');
    await flushPromises();

    await button(dialog, 'Add to the 1 selected')!.trigger('click');
    const [selected] = dialog.emitted<[Set<string>]>('update:selected')!.at(-1)!;
    expect([...selected]).toEqual(['someone-else', 'jdoe']);
  });

  it('says how many matches are disabled or missing from the loaded list', async () => {
    match.mockResolvedValueOnce({
      results: [
        { entry: 'old', status: 'matched', user: person('old', { enabled: false }) },
        { entry: 'jdoe', status: 'matched', user: person('jdoe') },
        { entry: 'new', status: 'matched', user: person('new') },
      ],
    });
    const dialog = mount(PasteListDialog, {
      props: { visible: true, selected: new Set<string>(), isLoaded: (id) => id !== 'new' },
      global: { plugins: [PrimeVue], stubs: { teleport: true } },
    });
    await flushPromises();
    await dialog.get('textarea').setValue('old\njdoe\nnew');
    await button(dialog, 'Find users')!.trigger('click');
    await flushPromises();

    expect(dialog.get('[role="status"]').text()).toBe(
      '2 users found from 3 entries, 1 of them disabled. 1 more user isn’t in the loaded list. Refresh the list to include them.',
    );
  });
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, watch } from 'vue';
import { describe, expect, it } from 'vitest';
import { useDetailRecord } from './useDetailRecord.js';

// A detail page reduced to what matters here: it loads the record for its
// `id` prop and shows it, or a loading line.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const pending = new Map<string, ReturnType<typeof deferred<{ id: string; name: string }>>>();
const DetailPage = defineComponent({
  props: { id: { type: String, required: true } },
  setup(props) {
    const { record, loading, load } = useDetailRecord({
      id: () => props.id,
      fetch: (id) => {
        const d = deferred<{ id: string; name: string }>();
        pending.set(id, d);
        return d.promise;
      },
      notFoundMessage: 'Not found',
      failedMessage: 'Failed',
    });
    watch(() => props.id, load, { immediate: true });
    return () => h('p', record.value ? record.value.name : loading.value ? 'Loading…' : '');
  },
});

describe('a detail page moving between records', () => {
  it('shows only the latest record, whatever order the responses arrive in', async () => {
    const page = mount(DetailPage, { props: { id: 'a' } });
    await page.setProps({ id: 'b' });

    // B's response arrives first, then A's slower one.
    pending.get('b')!.resolve({ id: 'b', name: 'Bob' });
    await flushPromises();
    pending.get('a')!.resolve({ id: 'a', name: 'Alice' });
    await flushPromises();

    expect(page.text()).toBe('Bob');
  });

  it('drops the previous record the moment the id changes', async () => {
    const page = mount(DetailPage, { props: { id: 'a' } });
    pending.get('a')!.resolve({ id: 'a', name: 'Alice' });
    await flushPromises();
    expect(page.text()).toBe('Alice');

    await page.setProps({ id: 'b' });
    expect(page.text()).toBe('Loading…');
  });
});

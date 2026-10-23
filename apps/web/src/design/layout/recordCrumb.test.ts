// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { recordCrumbLabel, useRecordCrumb } from './recordCrumb.js';

const names = ref<Record<string, string | null>>({});
const DetailPage = defineComponent({
  props: { id: { type: String, required: true } },
  setup(props) {
    useRecordCrumb(
      () => props.id,
      () => names.value[props.id],
    );
    return () => h('p');
  },
});

describe('the breadcrumb for a detail page', () => {
  it('shows the placeholder while the record loads, then its name', async () => {
    names.value = { a: null };
    const page = mount(DetailPage, { props: { id: 'a' } });
    expect(recordCrumbLabel('a', 'User')).toBe('User');

    names.value = { a: 'Alice' };
    await nextTick();
    expect(recordCrumbLabel('a', 'User')).toBe('Alice');
    page.unmount();
  });

  it("never shows one record's name for another", async () => {
    names.value = { a: 'Alice', b: null };
    const page = mount(DetailPage, { props: { id: 'a' } });
    await page.setProps({ id: 'b' });
    expect(recordCrumbLabel('b', 'User')).toBe('User');
    page.unmount();
  });

  it('forgets the name when the page closes', async () => {
    names.value = { a: 'Alice' };
    const page = mount(DetailPage, { props: { id: 'a' } });
    page.unmount();
    expect(recordCrumbLabel('a', 'User')).toBe('User');
  });
});

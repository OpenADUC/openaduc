// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { defineComponent, h, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShortcutSheet from './ShortcutSheet.vue';
import { useShortcuts, type Shortcut } from '../composables/useShortcuts.js';

enableAutoUnmount(afterEach);
afterEach(() => {
  for (const el of document.querySelectorAll('.extra')) el.remove();
});

const unlock = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
const next = vi.fn();
const openRow = vi.fn();
const locked = ref(false);
const enabled = ref(true);

// A page with an Unlock that needs a locked account, Enable and Disable on
// one key, and a row shortcut that repeats while held.
const Page = defineComponent({
  setup() {
    useShortcuts((): Shortcut[] => [
      {
        key: 'u',
        label: 'Unlock account',
        section: 'Actions',
        unavailable: locked.value ? null : 'account isn’t locked',
        run: unlock,
      },
      {
        key: 'e',
        label: 'Enable account',
        section: 'Actions',
        unavailable: enabled.value ? 'account is enabled' : null,
        run: enable,
      },
      {
        key: 'e',
        label: 'Disable account',
        section: 'Actions',
        unavailable: enabled.value ? null : 'account is disabled',
        run: disable,
      },
      { key: 'j', label: 'Next row', section: 'List', repeats: true, run: next },
      { key: 'Enter', label: 'Open the row', section: 'List', run: openRow },
    ]);
    return () => h('div', [h('input', { class: 'field' }), h('button', { class: 'btn' }, 'Go')]);
  },
});

async function open() {
  vi.clearAllMocks();
  locked.value = true;
  enabled.value = true;
  const sheet = mount(ShortcutSheet, {
    attachTo: document.body,
    global: { plugins: [PrimeVue] },
  });
  const page = mount(Page, { attachTo: document.body });
  await flushPromises();
  return { sheet, page };
}

// The dialog teleports to the body.
const sheetDialog = () => document.querySelector('[role="dialog"]');

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('single-key shortcuts', () => {
  it('runs the page’s shortcut for its key', async () => {
    await open();
    const e = press('u');
    expect(unlock).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
    press('x');
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('ignores keys typed into a field', async () => {
    const { page } = await open();
    press('u', {}, page.get('.field').element);
    for (const html of [
      '<textarea></textarea>',
      '<select></select>',
      '<div contenteditable="true"><span>x</span></div>',
      '<div role="combobox"></div>',
    ]) {
      const host = document.createElement('div');
      host.className = 'extra';
      host.innerHTML = html;
      document.body.append(host);
      press('u', {}, host.querySelector('span') ?? host.firstElementChild!);
    }
    expect(unlock).not.toHaveBeenCalled();
  });

  it('takes keys while a checkbox, radio button or button input has focus', async () => {
    await open();
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range']) {
      const host = document.createElement('div');
      host.className = 'extra';
      host.innerHTML = `<input type="${type}">`;
      document.body.append(host);
      press('u', {}, host.firstElementChild!);
      press('Enter', {}, host.firstElementChild!);
    }
    expect(unlock).toHaveBeenCalledTimes(6);
    expect(openRow).not.toHaveBeenCalled();
  });

  it('takes a letter typed with Caps Lock on', async () => {
    await open();
    press('U');
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('ignores keys with a modifier held, but takes ? with Shift', async () => {
    await open();
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)
      press('u', { [mod]: true });
    press('U', { shiftKey: true });
    expect(unlock).not.toHaveBeenCalled();

    press('?', { shiftKey: true });
    await flushPromises();
    expect(sheetDialog()).not.toBeNull();
  });

  it('ignores keys while a dialog or menu is open', async () => {
    await open();
    for (const html of [
      '<div role="dialog"></div>',
      '<div role="alertdialog"></div>',
      '<div class="p-menu p-menu-overlay"></div>',
    ]) {
      document.body.insertAdjacentHTML('beforeend', `<div class="extra">${html}</div>`);
      press('u');
      document.querySelector('.extra')!.remove();
    }
    expect(unlock).not.toHaveBeenCalled();
    press('u');
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('won’t run a shortcut that can’t run now', async () => {
    await open();
    locked.value = false;
    const e = press('u');
    expect(unlock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('runs whichever shortcut on a shared key can run', async () => {
    await open();
    press('e');
    expect(disable).toHaveBeenCalledOnce();
    enabled.value = false;
    press('e');
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
  });

  it('leaves Enter to a focused button', async () => {
    const { page } = await open();
    const e = press('Enter', {}, page.get('.btn').element);
    expect(e.defaultPrevented).toBe(false);
    expect(openRow).not.toHaveBeenCalled();
    press('Enter');
    expect(openRow).toHaveBeenCalledOnce();
  });

  it('repeats only the shortcuts meant to while a key is held', async () => {
    await open();
    press('u', { repeat: true });
    press('j', { repeat: true });
    expect(unlock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('stops offering a page’s shortcuts once the page goes', async () => {
    const { page } = await open();
    page.unmount();
    press('u');
    expect(unlock).not.toHaveBeenCalled();
  });

  it('does nothing once the shell drops the sheet, as in the Old School view', async () => {
    const { sheet } = await open();
    sheet.unmount();
    press('u');
    expect(unlock).not.toHaveBeenCalled();
  });
});

describe('the shortcut cheat sheet', () => {
  it('lists the page’s shortcuts by section, and why one can’t run now', async () => {
    await open();
    locked.value = false;
    press('?', { shiftKey: true });
    await flushPromises();

    const dialog = sheetDialog()!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Keyboard shortcuts');
    expect([...dialog.querySelectorAll('.sheet-title')].map((t) => t.textContent)).toEqual([
      'List',
      'Actions',
      'General',
    ]);
    const rows = [...dialog.querySelectorAll('.sheet-row')].map((r) => ({
      text: [...r.children].map((c) => c.textContent!.replace(/\s+/g, ' ').trim()).join(' '),
      greyed: r.classList.contains('is-unavailable'),
    }));
    expect(rows).toEqual([
      { text: 'j Next row', greyed: false },
      { text: 'Enter Open the row', greyed: false },
      { text: 'u Unlock account (account isn’t locked)', greyed: true },
      { text: 'e Disable account', greyed: false },
      { text: '? Show keyboard shortcuts', greyed: false },
    ]);
  });

  it('takes no shortcuts while it’s open', async () => {
    await open();
    press('?', { shiftKey: true });
    await flushPromises();
    press('u');
    expect(unlock).not.toHaveBeenCalled();
  });
});

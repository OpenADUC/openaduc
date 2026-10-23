// SPDX-License-Identifier: BUSL-1.1
import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useResultKeys } from './useResultKeys.js';

interface Row {
  key: string;
  actions: string[];
}

const jane: Row = { key: 'jane', actions: ['unlock', 'reset', 'disable'] };
const john: Row = { key: 'john', actions: ['reset', 'disable'] };
const sales: Row = { key: 'sales', actions: [] };

function keys(options: { preselect?: boolean; ready?: boolean } = {}) {
  const rows = ref<Row[]>([]);
  const state = { preselect: options.preselect ?? false, ready: options.ready ?? true };
  const k = useResultKeys<string, Row>({
    rows,
    preselect: () => state.preselect,
    ready: () => state.ready,
  });
  const press = (key: string, init: Partial<KeyboardEvent> & { caretAtEnd?: boolean } = {}) => {
    const { caretAtEnd = true, ...rest } = init;
    const e = { key, preventDefault: vi.fn(), ...rest } as unknown as KeyboardEvent;
    return { intent: k.keydown(e, caretAtEnd), prevented: vi.mocked(e.preventDefault).mock.calls };
  };
  const show = async (...next: Row[]) => {
    rows.value = next;
    await nextTick();
  };
  return { k, rows, state, press, show };
}

describe('keys over results with actions', () => {
  it('moves into a row’s actions with → or Tab, through them, and back out', async () => {
    const { k, press, show } = keys();
    await show(jane, john);
    expect(k.selectedAction.value).toBeNull();

    press('ArrowRight');
    expect(k.selectedAction.value).toBe('unlock');
    press('ArrowRight');
    press('ArrowRight');
    press('ArrowRight');
    expect(k.selectedAction.value).toBe('disable');
    press('ArrowLeft');
    expect(k.selectedAction.value).toBe('reset');
    press('Tab', { shiftKey: true });
    expect(k.selectedAction.value).toBeNull();

    press('Tab');
    expect(k.selectedAction.value).toBe('unlock');
    expect(press('Enter').intent).toEqual({ kind: 'run', row: jane, action: 'unlock' });
  });

  it('leaves Tab alone once in the actions, and where there are none, so it can leave the box', async () => {
    const { press, show } = keys();
    await show(jane, sales);

    expect(press('Tab').prevented).toHaveLength(1);
    expect(press('Tab').prevented).toHaveLength(0);
    expect(press('Tab', { shiftKey: true }).prevented).toHaveLength(1);
    expect(press('Tab', { shiftKey: true }).prevented).toHaveLength(0);

    press('ArrowDown');
    expect(press('Tab').prevented).toHaveLength(0);
  });

  it('leaves → to the text while the caret isn’t at its end', async () => {
    const { k, press, show } = keys();
    await show(jane);

    expect(press('ArrowRight', { caretAtEnd: false }).prevented).toHaveLength(0);
    expect(k.selectedAction.value).toBeNull();
    expect(press('ArrowLeft').prevented).toHaveLength(0);
  });

  it('backs out of the actions on Esc before it closes', async () => {
    const { k, press, show } = keys();
    await show(jane);

    press('Tab');
    expect(press('Escape').intent).toBeNull();
    expect(k.selectedAction.value).toBeNull();
    expect(press('Escape').intent).toEqual({ kind: 'close' });
  });

  it('opens a row on Enter when no action is selected', async () => {
    const { press, show } = keys();
    await show(jane, john);

    press('ArrowDown');
    expect(press('Enter').intent).toEqual({ kind: 'open', row: john });
  });

  it('selects the first action of each highlighted row with preselect, and Esc closes', async () => {
    const { k, press, show } = keys({ preselect: true });
    await show(jane, sales, john);
    expect(k.selectedAction.value).toBe('unlock');

    press('ArrowDown');
    await nextTick();
    expect(k.selectedAction.value).toBeNull();
    press('ArrowDown');
    await nextTick();
    expect(k.selectedAction.value).toBe('reset');
    expect(press('Escape').intent).toEqual({ kind: 'close' });
  });

  it('waits on Enter while the rows don’t answer the text yet', async () => {
    const { press, show, state } = keys({ preselect: true, ready: false });
    await show(jane);

    expect(press('Enter').intent).toEqual({ kind: 'wait' });
    state.ready = true;
    expect(press('Enter').intent).toEqual({ kind: 'run', row: jane, action: 'unlock' });
  });

  it('ignores a held Enter and keys composing text', async () => {
    const { k, press, show } = keys({ preselect: true });
    await show(jane, john);

    expect(press('Enter', { repeat: true }).intent).toBeNull();
    expect(press('Enter', { isComposing: true }).intent).toBeNull();
    // Some browsers mark an input method's keys only by this code.
    expect(press('Enter', { keyCode: 229 }).intent).toBeNull();
    expect(press('ArrowDown', { isComposing: true }).prevented).toHaveLength(0);
    expect(k.highlight.value).toBe(0);
  });

  it('keeps the highlight on a row through a refresh when asked, else starts at the top', async () => {
    const { k, press, show } = keys();
    await show(jane, john);
    press('ArrowDown');
    await nextTick();

    k.keepHighlightOn('john');
    await show({ ...jane }, { ...john });
    expect(k.highlighted.value?.key).toBe('john');

    await show(jane, john);
    expect(k.highlighted.value?.key).toBe('jane');
  });
});

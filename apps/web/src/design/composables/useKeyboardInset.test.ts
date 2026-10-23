// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardInset } from './useKeyboardInset.js';

// A phone's visual viewport: what's left of the window once the on-screen
// keyboard is up.
class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
}

const Shell = defineComponent({
  setup() {
    useKeyboardInset();
    return () => h('div');
  },
});

const inset = () => document.documentElement.style.getPropertyValue('--keyboard-inset');

describe('the keyboard inset', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is how much of the window the keyboard covers, kept up to date', () => {
    const viewport = new FakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    const shell = mount(Shell);
    expect(inset()).toBe('0px');

    // Safari: the keyboard shrinks the visual viewport and pans it down.
    viewport.height = 450;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('354px');

    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(inset()).toBe('0px');

    shell.unmount();
    expect(inset()).toBe('');
  });

  // Chrome resizes the whole window instead (interactive-widget in
  // index.html), so nothing is covered.
  it('is nothing when the window itself shrinks', () => {
    const viewport = new FakeVisualViewport();
    viewport.height = 450;
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 450);
    mount(Shell);
    expect(inset()).toBe('0px');
  });
});

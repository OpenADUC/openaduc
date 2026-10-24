// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVisualViewport } from './useVisualViewport.js';

// A phone's visual viewport: what's left of the window once the on-screen
// keyboard is up.
class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
}

const Shell = defineComponent({
  setup() {
    useVisualViewport();
    return () => h('div');
  },
});

const style = document.documentElement.style;
const edges = () => ({
  top: style.getPropertyValue('--visual-viewport-top'),
  bottom: style.getPropertyValue('--keyboard-inset'),
});

describe('the visible part of the window', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows the keyboard, at both edges, kept up to date', () => {
    const viewport = new FakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    const shell = mount(Shell);
    expect(edges()).toEqual({ top: '0px', bottom: '0px' });

    // Safari: the keyboard shrinks the visual viewport and pans it down,
    // so the window's top is out of sight too.
    viewport.height = 450;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event('resize'));
    expect(edges()).toEqual({ top: '40px', bottom: '354px' });

    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(edges()).toEqual({ top: '0px', bottom: '0px' });

    shell.unmount();
    expect(edges()).toEqual({ top: '', bottom: '' });
  });

  // Chrome resizes the whole window instead (interactive-widget in
  // index.html), so nothing is hidden.
  it('is the whole window when the window itself shrinks', () => {
    const viewport = new FakeVisualViewport();
    viewport.height = 450;
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 450);
    mount(Shell);
    expect(edges()).toEqual({ top: '0px', bottom: '0px' });
  });

  // Zooming in shrinks and pans the visual viewport too, but sheets and
  // the search panel should stay where the page put them.
  it('ignores a pinch-zoom', () => {
    const viewport = new FakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    mount(Shell);

    viewport.scale = 2;
    viewport.height = 422;
    viewport.offsetTop = 200;
    viewport.dispatchEvent(new Event('resize'));
    expect(edges()).toEqual({ top: '0px', bottom: '0px' });
  });
});

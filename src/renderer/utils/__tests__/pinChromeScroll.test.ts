// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { installChromeScrollPin, PIN_SCROLL_ATTR } from '../pinChromeScroll';

// jsdom has no layout, so give each box a writable scroll position to observe.
function scrollable(el: Element, top: number, left = 0): Element {
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { value: left, writable: true, configurable: true });
  return el;
}

describe('installChromeScrollPin (#1679)', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = '';
  });

  it('resets a programmatic scroll of the app shell and the viewport back to 0', () => {
    uninstall = installChromeScrollPin(document);
    const shell = document.createElement('div');
    shell.setAttribute(PIN_SCROLL_ATTR, '');
    document.body.appendChild(shell);

    scrollable(shell, 30, 4);
    shell.dispatchEvent(new Event('scroll'));
    expect(shell.scrollTop).toBe(0);
    expect(shell.scrollLeft).toBe(0);

    // A viewport scroll is dispatched on the document, not on <html>.
    const html = scrollable(document.documentElement, 36);
    document.dispatchEvent(new Event('scroll'));
    expect(html.scrollTop).toBe(0);
  });

  it('leaves real scrollers (sidebar lists, terminals) alone', () => {
    uninstall = installChromeScrollPin(document);
    const list = document.createElement('div');
    document.body.appendChild(list);

    scrollable(list, 120);
    list.dispatchEvent(new Event('scroll'));
    expect(list.scrollTop).toBe(120);
  });
});

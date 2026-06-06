import { describe, expect, it, vi } from 'vitest';
import {
  getSmartSnapshotViaEval,
  getLocatorByRef,
  clearElementCache,
  INTERACTIVE_SELECTOR,
} from '../dom-intelligence';

describe('INTERACTIVE_SELECTOR', () => {
  it('is a non-empty selector shared with browser_snapshot', () => {
    expect(typeof INTERACTIVE_SELECTOR).toBe('string');
    expect(INTERACTIVE_SELECTOR).toContain('button');
    expect(INTERACTIVE_SELECTOR).toContain('[contenteditable="true"]');
  });
});

describe('getSmartSnapshotViaEval', () => {
  it('maps the evaluator payload into a SmartSnapshot with data-wmux-ref locators', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      url: 'https://x.test/',
      title: 'X',
      content: 'hello',
      elements: [
        { ref: 1, role: 'button', name: 'OK' },
        { ref: 2, role: 'textbox', name: 'Search', value: 'q', description: 'main search' },
      ],
    });

    const snap = await getSmartSnapshotViaEval(evaluate, { maxContentLength: 100 });

    expect(snap.url).toBe('https://x.test/');
    expect(snap.title).toBe('X');
    expect(snap.content).toBe('hello');
    expect(snap.elements).toEqual([
      { ref: 1, role: 'button', name: 'OK', locator: '[data-wmux-ref="1"]' },
      {
        ref: 2,
        role: 'textbox',
        name: 'Search',
        value: 'q',
        description: 'main search',
        locator: '[data-wmux-ref="2"]',
      },
    ]);
  });

  it('injects a 1-based, data-wmux-ref-tagging script using the shared selector', async () => {
    const evaluate = vi.fn().mockResolvedValue({ url: '', title: '', content: '', elements: [] });
    await getSmartSnapshotViaEval(evaluate);
    const script = evaluate.mock.calls[0][0] as string;
    expect(script).toContain('data-wmux-ref');
    expect(script).toContain('i + 1'); // 1-based, matches getSmartSnapshot / getLocatorByRef
    expect(script).toContain('button'); // INTERACTIVE_SELECTOR embedded
    expect(script).toContain('slice(0, 100)');
  });

  it('populates elementCache so getLocatorByRef resolves after a null->page flip', async () => {
    clearElementCache();
    const evaluate = vi.fn().mockResolvedValue({
      url: 'u',
      title: 't',
      content: 'c',
      elements: [{ ref: 1, role: 'link', name: 'Home' }],
    });
    await getSmartSnapshotViaEval(evaluate);
    // The cache must hold a CSS-selector locator that page.locator() can resolve
    // against the data-wmux-ref attributes the snapshot left in the DOM.
    expect(getLocatorByRef(1)).toBe('[data-wmux-ref="1"]');
    expect(getLocatorByRef(2)).toBeNull();
  });

  it('tolerates a null / element-less payload', async () => {
    const evaluate = vi.fn().mockResolvedValue(null);
    const snap = await getSmartSnapshotViaEval(evaluate);
    expect(snap).toEqual({ url: '', title: '', elements: [], content: '' });
  });
});

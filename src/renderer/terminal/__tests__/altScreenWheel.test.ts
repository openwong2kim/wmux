// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  isAltScreen,
  pageKeyFor,
  wheelDeltaToPages,
  attachAltScreenWheel,
} from '../altScreenWheel';

describe('isAltScreen', () => {
  it('is true only for the alternate buffer', () => {
    expect(isAltScreen({ buffer: { active: { type: 'alternate' } } })).toBe(true);
    expect(isAltScreen({ buffer: { active: { type: 'normal' } } })).toBe(false);
    expect(isAltScreen({})).toBe(false);
    expect(isAltScreen(null)).toBe(false);
  });
});

describe('pageKeyFor', () => {
  it('emits CSI PageUp / PageDown', () => {
    expect(pageKeyFor(true)).toBe('\x1b[5~');
    expect(pageKeyFor(false)).toBe('\x1b[6~');
  });
});

describe('wheelDeltaToPages', () => {
  it('maps one line-notch to one page', () => {
    expect(wheelDeltaToPages(0, -1, 1)).toEqual({ pages: -1, remainder: 0 });
    expect(wheelDeltaToPages(0, 1, 1)).toEqual({ pages: 1, remainder: 0 });
  });

  it('banks pixel leftovers until a notch-sized move', () => {
    const first = wheelDeltaToPages(0, -40, 0);
    expect(first.pages).toBe(0);
    expect(first.remainder).toBe(-40);
    const second = wheelDeltaToPages(first.remainder, -60, 0);
    expect(second.pages).toBe(-1);
    expect(second.remainder).toBe(-4);
  });

  it('caps a huge flick so a trackpad cannot dump many pages', () => {
    expect(wheelDeltaToPages(0, -5000, 0).pages).toBe(-3);
  });
});

describe('attachAltScreenWheel', () => {
  function host(): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  function fire(el: HTMLElement, init: WheelEventInit): WheelEvent {
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  }

  it('does not steal the wheel on the normal buffer', () => {
    const send = vi.fn();
    const el = host();
    const detach = attachAltScreenWheel({ buffer: { active: { type: 'normal' } } }, el, send);
    const ev = fire(el, { deltaY: -120, deltaMode: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    detach();
    el.remove();
  });

  it('sends PageUp on the alt screen for an upward notch', () => {
    const send = vi.fn();
    const el = host();
    const detach = attachAltScreenWheel({ buffer: { active: { type: 'alternate' } } }, el, send);
    const ev = fire(el, { deltaY: -1, deltaMode: 1 });
    expect(send).toHaveBeenCalledWith('\x1b[5~');
    expect(ev.defaultPrevented).toBe(true);
    detach();
    el.remove();
  });

  it('sends PageDown for a downward notch', () => {
    const send = vi.fn();
    const el = host();
    const detach = attachAltScreenWheel({ buffer: { active: { type: 'alternate' } } }, el, send);
    fire(el, { deltaY: 1, deltaMode: 1 });
    expect(send).toHaveBeenCalledWith('\x1b[6~');
    detach();
    el.remove();
  });

  it('leaves ctrl/meta/alt chords alone (font zoom, browser)', () => {
    const send = vi.fn();
    const el = host();
    const detach = attachAltScreenWheel({ buffer: { active: { type: 'alternate' } } }, el, send);
    fire(el, { deltaY: -1, deltaMode: 1, ctrlKey: true });
    fire(el, { deltaY: -1, deltaMode: 1, metaKey: true });
    expect(send).not.toHaveBeenCalled();
    detach();
    el.remove();
  });
});

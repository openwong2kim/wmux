// @vitest-environment jsdom
// Moa's mascot: the four states of the approved art, the small-size cut (body
// and face only), per-instance gradient ids, and motion that stops under both
// the OS reduced-motion preference and Moa's own Reduce motion setting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaMascot } from '../MoaMascot';
import { useStore } from '../../../stores';
import type { MoaMascotState, MoaState } from '../../../../shared/moa';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moa = (reduceMotion: boolean): MoaState => ({
  config: { enabled: true, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion, defaultReason: null },
  hq: { workspaceId: 'hq', state: 'ok' },
  archive: { unacked: 0, total: 0 },
});

let container: HTMLDivElement;
let root: Root;
const savedMatchMedia = window.matchMedia;

function setOsReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setOsReducedMotion(false);
  useStore.setState({ moa: moa(false) } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.matchMedia = savedMatchMedia;
  useStore.setState({ moa: null } as never);
});

const svg = () => container.querySelector('svg')!;
const animated = () => container.querySelectorAll('[class*="moa-"]:not(svg)').length;

describe('MoaMascot', () => {
  it.each<[MoaMascotState, string]>([
    ['idle', 'moa-blink'],
    ['working', 'moa-dots'],
    ['needs-you', 'moa-hop'],
    ['done', 'moa-wave-l'],
  ])('draws the %s state with its own motion', (state, cls) => {
    act(() => root.render(<MoaMascot state={state} size={96} />));
    expect(svg().getAttribute('data-moa-mascot')).toBe(state);
    expect(svg().getAttribute('data-moa-size')).toBe('full');
    expect(svg().getAttribute('data-motion')).toBe('full');
    expect(container.querySelector(`.${cls}`)).not.toBeNull();
  });

  it('marks needs-you with the "!" and done with hearts, working with three dots', () => {
    act(() => root.render(<MoaMascot state="needs-you" size={96} />));
    expect(container.querySelector('[data-moa-effect="bang"]')).not.toBeNull();
    act(() => root.render(<MoaMascot state="done" size={96} />));
    expect(container.querySelectorAll('[data-moa-effect="heart"]')).toHaveLength(2);
    act(() => root.render(<MoaMascot state="working" size={96} />));
    expect(container.querySelectorAll('[data-moa-effect="dots"] circle')).toHaveLength(3);
  });

  it('draws only the body and the face at 28px and under', () => {
    for (const size of [20, 28]) {
      act(() => root.render(<MoaMascot state="needs-you" size={size} />));
      expect(svg().getAttribute('data-moa-size')).toBe('small');
      expect(svg().getAttribute('width')).toBe(String(size));
      expect(container.querySelector('[data-moa-effect]')).toBeNull();
      // body, sheen, two eyes, two cheeks, mouth: no limbs or tuft
      expect(container.querySelectorAll('svg > g > *')).toHaveLength(7);
    }
  });

  it('is decorative without a label and an image with one', () => {
    act(() => root.render(<MoaMascot state="idle" size={20} />));
    expect(svg().getAttribute('aria-hidden')).toBe('true');
    expect(svg().getAttribute('role')).toBeNull();
    act(() => root.render(<MoaMascot state="idle" size={20} label="Moa" />));
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().getAttribute('aria-label')).toBe('Moa');
  });

  it('gives each instance its own gradient ids', () => {
    act(() => root.render(<><MoaMascot state="idle" size={96} /><MoaMascot state="idle" size={20} /></>));
    const ids = [...container.querySelectorAll('radialGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of container.querySelectorAll('[fill^="url(#"]')) {
      const ref = /url\(#(.+)\)/.exec(el.getAttribute('fill')!)![1];
      expect(ids).toContain(ref);
      expect(ref).toMatch(/^[\w-]+$/);
    }
  });

  it('holds still under the OS reduced-motion preference', () => {
    setOsReducedMotion(true);
    act(() => root.render(<MoaMascot state="done" size={96} />));
    expect(svg().getAttribute('data-motion')).toBe('reduced');
    expect(animated()).toBe(0);
  });

  it("holds still under Moa's own Reduce motion setting", () => {
    act(() => root.render(<MoaMascot state="needs-you" size={96} />));
    expect(animated()).toBeGreaterThan(0);
    act(() => useStore.setState({ moa: moa(true) } as never));
    expect(svg().getAttribute('data-motion')).toBe('reduced');
    expect(animated()).toBe(0);
  });
});

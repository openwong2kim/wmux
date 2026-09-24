// @vitest-environment jsdom
//
// The tour card on the shared primitives: Next is the one warm primary, Back
// and Skip are not, steps with a clip show it (as a labelled image), steps
// without one show text only, and the keyboard path works end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import OnboardingOverlay from '../OnboardingOverlay';
import type { OnboardingStep } from '../steps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe() { /* jsdom has no layout */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
}

const STEPS: OnboardingStep[] = [
  { id: 'a', titleKey: 'onboarding.step1.title', descriptionKey: 'onboarding.step1.description', targetSelector: '#target-a', placement: 'bottom', media: 'panes' },
  { id: 'b', titleKey: 'onboarding.step4.title', descriptionKey: 'onboarding.step4.description', targetSelector: '#target-b', placement: 'top' },
];

let container: HTMLDivElement;
let root: Root;
let targets: HTMLElement[];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  targets = ['target-a', 'target-b'].map((id) => {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  targets.forEach((t) => t.remove());
  vi.unstubAllGlobals();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function mount(onComplete = vi.fn()) {
  await act(async () => {
    root.render(createElement(OnboardingOverlay, { onComplete, steps: STEPS }));
  });
  return onComplete;
}

describe('OnboardingOverlay', () => {
  it('renders a labelled card with the clip and a single warm primary (Next)', async () => {
    await mount();
    const card = q('onboarding-card')!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.hasAttribute('aria-modal')).toBe(false);
    expect(document.getElementById(card.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Your terminal');

    const media = q('onboarding-media')!;
    expect(media.getAttribute('role')).toBe('img');
    expect(media.getAttribute('aria-label')).toBe('Your terminal');
    expect(media.querySelector('video')?.getAttribute('src')).toMatch(/panes.*\.webm/);

    const primaries = card.querySelectorAll('.ui-btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(q('onboarding-next'));
    expect(q('onboarding-skip')?.className).toContain('ui-btn-ghost');
    // No steel-filled Next any more.
    expect(q('onboarding-next')?.getAttribute('style') ?? '').not.toContain('accent-blue');
  });

  it('focuses Next on each step, and a step without a clip shows text only', async () => {
    await mount();
    expect(document.activeElement).toBe(q('onboarding-next'));
    await act(async () => q('onboarding-next')!.click());
    expect(q('onboarding-card')?.textContent).toContain('Settings');
    expect(q('onboarding-media')).toBeNull();
    expect(q('onboarding-prev')?.className).toContain('ui-btn-secondary');
    expect(document.activeElement).toBe(q('onboarding-next'));
  });

  it('Done on the last step and Escape both complete the tour', async () => {
    const onComplete = await mount();
    await act(async () => q('onboarding-next')!.click());
    expect(q('onboarding-next')?.textContent).toBe('Done');
    await act(async () => q('onboarding-next')!.click());
    expect(onComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('shows the poster, not a playing video, under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await mount();
    const media = q('onboarding-media')!;
    expect(media.dataset.motion).toBe('reduced');
    expect(media.querySelector('video')).toBeNull();
    expect(media.querySelector('img')?.getAttribute('src')).toMatch(/panes-poster.*\.webp/);
  });
});

// @vitest-environment jsdom
//
// The fan-out tour step points at the Multi Task button on the hover-revealed
// agent toolbar: the bar is held up while the step is on screen and let go
// after, and with the toolbar switched off the step falls back to another
// target instead of being skipped.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import OnboardingOverlay from '../OnboardingOverlay';
import { ONBOARDING_STEPS, type OnboardingStep } from '../steps';
import { useStore } from '../../../stores';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe() { /* jsdom has no layout */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
}

const fanOut = ONBOARDING_STEPS.find((s) => s.id === 'fan-out') as OnboardingStep;
const STEPS: OnboardingStep[] = [
  fanOut,
  { id: 'b', titleKey: 'onboarding.step4.title', descriptionKey: 'onboarding.step4.description', targetSelector: '#target-b', placement: 'top' },
];

let container: HTMLDivElement;
let root: Root;
const extra: HTMLElement[] = [];
const add = (attrs: Record<string, string>) => {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  extra.push(el);
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  add({ id: 'target-b' });
  add({ 'data-onboarding-target': 'pane-area' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.getState().setAgentToolbarTourHold(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  extra.splice(0).forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`) as HTMLElement;

describe('fan-out tour step', () => {
  it('targets the Multi Task button and holds the agent toolbar up only while it is on screen', async () => {
    add({ 'data-onboarding-target': 'fanout' });
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: STEPS })); });
    expect(fanOut.targetSelector).toBe('[data-onboarding-target="fanout"]');
    expect(q('onboarding-card').textContent).toContain('Fan out in parallel');
    expect(useStore.getState().agentToolbarTourHold).toBe(true);

    await act(async () => q('onboarding-next').click());
    expect(useStore.getState().agentToolbarTourHold).toBe(false);
  });

  it('falls back to the pane when the toolbar is off, so the step still shows', async () => {
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: STEPS })); });
    expect(q('onboarding-card').textContent).toContain('Fan out in parallel');
    expect(q('onboarding-card').textContent).toContain('1 / 2');
  });

  it('releases the hold when the tour ends mid-step', async () => {
    add({ 'data-onboarding-target': 'fanout' });
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: STEPS })); });
    expect(useStore.getState().agentToolbarTourHold).toBe(true);
    await act(async () => root.render(createElement('div')));
    expect(useStore.getState().agentToolbarTourHold).toBe(false);
  });
});

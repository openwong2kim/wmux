// @vitest-environment jsdom
//
// The browser tour step says what each browser backend is for and links to
// Settings › Browser. It points at the pane's browser button, and with no such
// button on screen (compact pane chrome) it falls back to the status bar
// instead of being skipped.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import OnboardingOverlay from '../OnboardingOverlay';
import { ONBOARDING_STEPS, resolveStepTarget, type OnboardingStep } from '../steps';
import { useStore } from '../../../stores';
import { en } from '../../../i18n/locales/en';
import { BROWSER_BACKENDS } from '../../../../shared/browserBackend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver {
  observe() { /* jsdom has no layout */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
}

const browserStep = ONBOARDING_STEPS.find((s) => s.id === 'open-browser') as OnboardingStep;
const STEPS: OnboardingStep[] = [
  browserStep,
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
  add({ 'data-onboarding-target': 'status-bar' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  extra.splice(0).forEach((el) => el.remove());
  useStore.getState().clearSettingsInitialTab();
  useStore.getState().setSettingsPanelVisible(false);
  vi.unstubAllGlobals();
});

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`) as HTMLElement;

describe('browser tour step', () => {
  it('names every browser backend with what it is for', async () => {
    add({ 'data-pane-action': 'new-browser' });
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: STEPS })); });
    const items = q('onboarding-items');
    const terms = [...items.querySelectorAll('dt')].map((el) => el.textContent);
    const uses = [...items.querySelectorAll('dd')].map((el) => el.textContent);
    // One line per backend the app offers, in the order the copy introduces them.
    expect(terms).toEqual([en['onboarding.step3.builtin'], en['onboarding.step3.chrome'], en['onboarding.step3.external']]);
    expect(terms).toHaveLength(BROWSER_BACKENDS.length);
    expect(uses).toEqual([en['onboarding.step3.builtinUse'], en['onboarding.step3.chromeUse'], en['onboarding.step3.externalUse']]);
    // Three short lines and the Settings link: no note about other chrome.
    expect(q('onboarding-card').querySelector('.onboarding-note')).toBeNull();
    // The card's accessible description covers the choices too.
    expect(q('onboarding-card').getAttribute('aria-describedby')).toContain(items.id);
  });

  it('spotlights the pane browser button when there is one', () => {
    add({ 'data-pane-action': 'new-browser' });
    expect(resolveStepTarget(browserStep)).toBe('[data-pane-action="new-browser"]');
  });

  it('falls back to the status bar when no pane shows a browser button, so the step still shows', async () => {
    expect(resolveStepTarget(browserStep)).toBe('[data-onboarding-target="status-bar"]');
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: STEPS })); });
    expect(q('onboarding-card').textContent).toContain(en['onboarding.step3.title']);
    expect(q('onboarding-card').textContent).toContain('1 / 2');
  });

  it('ends the tour and opens Settings › Browser from its link', async () => {
    add({ 'data-pane-action': 'new-browser' });
    const onComplete = vi.fn();
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete, steps: STEPS })); });
    const link = q('onboarding-settings-link');
    expect(link.textContent).toBe(en['onboarding.step3.settingsLink']);
    // A link, not a second primary: Next stays the card's one warm button.
    expect(link.className).not.toContain('ui-btn-primary');
    await act(async () => link.click());
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(useStore.getState().settingsInitialTab).toBe('browser');
  });

  it('has no choices or link on the other steps', async () => {
    await act(async () => { root.render(createElement(OnboardingOverlay, { onComplete: vi.fn(), steps: [STEPS[1]] })); });
    expect(q('onboarding-items')).toBeNull();
    expect(q('onboarding-settings-link')).toBeNull();
  });
});

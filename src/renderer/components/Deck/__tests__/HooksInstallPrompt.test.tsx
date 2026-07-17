// @vitest-environment jsdom
// HooksInstallPrompt — the two-trigger install nudge. jsdom + injected api
// (the AgentModeChip pattern): launch check, event re-trigger, install flow,
// fail-soft status errors, and the "already installed → never prompt" gate.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  HooksInstallPrompt,
  requestHooksInstallPrompt,
  type HooksBridgeApi,
} from '../HooksInstallPrompt';

const t = (k: string) => k;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

let roots: { root: Root; el: HTMLElement }[] = [];
function render(node: React.ReactElement): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  roots.push({ root, el });
  return el;
}
afterEach(() => {
  for (const { root, el } of roots) {
    act(() => root.unmount());
    el.remove();
  }
  roots = [];
});

function apiOf(over: Partial<HooksBridgeApi> = {}): HooksBridgeApi {
  return {
    status: async () => ({ installed: false }),
    install: async () => ({ ok: true, error: null }),
    ...over,
  };
}

describe('HooksInstallPrompt', () => {
  it('prompts on mount when hooks are missing', async () => {
    const el = render(<HooksInstallPrompt api={apiOf()} t={t} />);
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  it('stays hidden when hooks are installed', async () => {
    const el = render(
      <HooksInstallPrompt api={apiOf({ status: async () => ({ installed: true }) })} t={t} />,
    );
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('a status error fails soft to hidden (never nags on a broken check)', async () => {
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ status: async () => { throw new Error('boom'); } })}
        t={t}
      />,
    );
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('the window event re-triggers the prompt after a dismiss', async () => {
    const el = render(<HooksInstallPrompt api={apiOf()} t={t} />);
    await flush();
    act(() => (el.querySelector('[data-hooks-later]') as HTMLButtonElement).click());
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  it('install success shows the restart-sessions note', async () => {
    const install = vi.fn(async () => ({ ok: true, error: null }));
    const el = render(<HooksInstallPrompt api={apiOf({ install })} t={t} />);
    await flush();
    act(() => (el.querySelector('[data-hooks-install]') as HTMLButtonElement).click());
    await flush();
    expect(install).toHaveBeenCalledOnce();
    expect(el.textContent).toContain('hooks.prompt.doneTitle');
    act(() => (el.querySelector('[data-hooks-close]') as HTMLButtonElement).click());
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('install failure surfaces the error and keeps the prompt open', async () => {
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ install: async () => ({ ok: false, error: 'bridge missing' }) })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-install]') as HTMLButtonElement).click());
    await flush();
    const err = el.querySelector('[data-hooks-error]');
    expect(err?.textContent).toContain('bridge missing');
    expect(el.querySelector('[data-hooks-install]')).toBeTruthy();
  });
});

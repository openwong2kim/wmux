// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevConfigurePatch, JevSessionStatus } from '../../../../shared/jev';
import { en, type TranslationKey } from '../../../i18n/locales/en';
import JevSettings from '../JevSettings';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: TranslationKey) => en[key] }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let current: JevSessionStatus;
let api: ReturnType<typeof makeApi>;
let container: HTMLDivElement;
let root: Root;

function makeApi() {
  return {
    status: vi.fn(async () => ({ ...current })),
    configure: vi.fn(async (patch: JevConfigurePatch) => {
      current = patch.clearKey ? { enabled: false, hasKey: false } : {
        enabled: patch.enabled ?? current.enabled,
        hasKey: patch.apiKey ? true : current.hasKey,
      };
      return { ...current };
    }),
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  current = { enabled: false, hasKey: false };
  api = makeApi();
  (window as unknown as { electronAPI: unknown }).electronAPI = { deck: { jev: api } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() { await act(async () => root.render(createElement(JevSettings))); }
function query<T extends Element = HTMLElement>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`Missing test element: ${selector}`);
  return found;
}
const input = () => query<HTMLInputElement>('[data-testid="jev-key"]');
const toggle = () => query<HTMLButtonElement>('[data-testid="jev-enable"]');
const statusText = () => query('[data-testid="jev-status"]').textContent;
const button = (text: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === text);
  if (!found) throw new Error(`Missing test button: ${text}`);
  return found;
};
const click = async (text: string) => { await act(async () => button(text).click()); };
async function enterKey(key = 'dummy-test-key') {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing native input setter');
    setter.call(input(), key);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Jev session settings', () => {
  it('starts off and inert while reading, with disclosure wired to explicit consent', async () => {
    const read = deferred<JevSessionStatus>();
    api.status.mockReturnValueOnce(read.promise);
    await render();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(input().disabled).toBe(true);
    expect(statusText()).toContain('Checking');
    expect(api.configure).not.toHaveBeenCalled();
    const disclosure = (toggle().getAttribute('aria-describedby') ?? '').split(' ')
      .map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(disclosure).toContain('TypeSafe');
    expect(disclosure).toContain('only recognized short Fleet questions');
    expect(disclosure).toContain('desktop composer');
    expect(disclosure).toContain('during this app session');
    expect(disclosure).toContain('Phone behavior is unchanged');
    expect(disclosure).toContain('Board data, terminal content, repository content and conversation history are never sent');
    await act(async () => read.resolve(current));
    expect(toggle().disabled).toBe(true);
    expect(statusText()).toContain('No key entered');
  });

  it('keeps user-entered keys masked, clears the draft on save, and never auto-enables', async () => {
    await render();
    expect(input().type).toBe('password');
    expect(input().autocomplete).toBe('off');
    await enterKey();
    await click('Use key for this session');
    expect(api.configure).toHaveBeenCalledExactlyOnceWith({ apiKey: 'dummy-test-key' });
    expect(input().value).toBe('');
    expect(container.textContent).not.toContain('dummy-test-key');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(false);
    expect(statusText()).toContain('Key in session memory');
  });

  it('requires a separate switch action to enable, and permits switching off', async () => {
    current.hasKey = true;
    await render();
    await act(async () => toggle().click());
    expect(api.configure).toHaveBeenLastCalledWith({ enabled: true });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle().click());
    expect(api.configure).toHaveBeenLastCalledWith({ enabled: false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('cancel discards an unsubmitted key without changing the session', async () => {
    await render();
    await enterKey();
    await click('Cancel key entry');
    expect(input().value).toBe('');
    expect(api.configure).not.toHaveBeenCalled();
    expect(button('Use key for this session').disabled).toBe(true);
  });

  it('does not submit an empty or whitespace-only key', async () => {
    await render();
    expect(button('Use key for this session').disabled).toBe(true);
    await enterKey('   ');
    expect(button('Use key for this session').disabled).toBe(true);
    await act(async () => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(api.configure).not.toHaveBeenCalled();
  });

  it('clear removes the key, clears any draft and turns routing off', async () => {
    current = { enabled: true, hasKey: true };
    await render();
    await enterKey('dummy-replacement');
    await click('Clear key and turn off');
    expect(api.configure).toHaveBeenCalledExactlyOnceWith({ clearKey: true });
    expect(input().value).toBe('');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(true);
    expect(statusText()).toContain('No key entered');
  });

  it('guards repeated submissions and all other actions during the same pending operation', async () => {
    current.hasKey = true;
    await render();
    await enterKey();
    const write = deferred<JevSessionStatus>();
    api.configure.mockReturnValueOnce(write.promise);
    await act(async () => {
      const form = query('form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      toggle().click();
      button('Clear key and turn off').click();
      button('Refresh Jev status').click();
    });
    expect(api.configure).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('');
    expect(input().disabled).toBe(true);
    expect(button('Cancel key entry').disabled).toBe(true);
    await act(async () => write.resolve({ enabled: false, hasKey: true }));
    expect(input().disabled).toBe(false);
  });

  it('reconciles a failed write without retrying or echoing sensitive error details', async () => {
    await render();
    await enterKey();
    api.configure.mockImplementationOnce(async () => {
      current.hasKey = true;
      throw new Error('Request failed for dummy-test-key');
    });
    await click('Use key for this session');
    expect(api.configure).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(input().value).toBe('');
    expect(query('[role="alert"]').textContent).toContain('Could not confirm');
    expect(container.textContent).not.toContain('dummy-test-key');
    expect(statusText()).toContain('Key in session memory');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('does not claim a failed clear succeeded', async () => {
    current = { enabled: true, hasKey: true };
    await render();
    api.configure.mockRejectedValueOnce(new Error('failure'));
    await click('Clear key and turn off');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(statusText()).toContain('Key in session memory');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows unknown and blocks mutations after failed reads until explicit refresh succeeds', async () => {
    api.status.mockRejectedValueOnce(new Error('dummy-read-secret'));
    await render();
    expect(statusText()).toContain('Unknown');
    expect(input().disabled).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).not.toContain('dummy-read-secret');
    await click('Refresh Jev status');
    expect(input().disabled).toBe(false);
    expect(statusText()).toContain('No key entered');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('requires refresh when both a write and its reconciliation fail', async () => {
    await render();
    await enterKey();
    api.configure.mockRejectedValueOnce(new Error('failure'));
    api.status.mockRejectedValueOnce(new Error('failure'));
    await click('Use key for this session');
    expect(statusText()).toContain('Unknown');
    expect(input().value).toBe('');
    expect(input().disabled).toBe(true);
    await click('Refresh Jev status');
    expect(input().disabled).toBe(false);
    expect(api.configure).toHaveBeenCalledTimes(1);
  });

  it('re-reads main on refresh without sending any draft key', async () => {
    await render();
    await enterKey();
    current = { enabled: true, hasKey: true };
    await click('Refresh Jev status');
    expect(statusText()).toContain('Enabled');
    expect(api.configure).not.toHaveBeenCalled();
    expect(input().value).toBe('dummy-test-key');
  });

  it('drops drafts when navigating away, then reads fresh session state on return', async () => {
    await render();
    await enterKey();
    await act(async () => root.render(null));
    current = { enabled: false, hasKey: false };
    await render();
    expect(input().value).toBe('');
    expect(api.configure).not.toHaveBeenCalled();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('ignores a pending operation after navigation instead of reconciling or updating the new screen', async () => {
    await render();
    await enterKey();
    const write = deferred<JevSessionStatus>();
    api.configure.mockReturnValueOnce(write.promise);
    await click('Use key for this session');
    await act(async () => root.render(null));
    await render();
    await act(async () => write.reject(new Error('dummy-test-key')));
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(statusText()).toContain('No key entered');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores obsolete initial reads after StrictMode remount', async () => {
    const oldRead = deferred<JevSessionStatus>();
    api.status.mockReturnValueOnce(oldRead.promise);
    await act(async () => root.render(createElement(StrictMode, null, createElement(JevSettings))));
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => oldRead.resolve({ enabled: true, hasKey: true }));
    expect(statusText()).toContain('No key entered');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(input().disabled).toBe(false);
  });

  it('fails closed if the desktop bridge is unavailable', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    await render();
    expect(statusText()).toContain('Unknown');
    expect(input().disabled).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

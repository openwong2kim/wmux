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

// ─── Durable refusal (#898 follow-up) ────────────────────────────────────────
//
// The regression these cover: dismissing set the local phase to `hidden`, and
// `maybePrompt` re-enters from `hidden` — so "Later" did not survive even the
// next trigger in the SAME session, and nothing survived a restart.

describe('HooksInstallPrompt — refusals', () => {
  // Deliberate, and the reason there are three buttons rather than two: a
  // snooze must not be read as a refusal of a warning the user has not yet been
  // given at the moment it matters. Raising agent mode is that moment. Anyone
  // who wants silence has the button next to it.
  it('Later still lets an agent-mode raise ask again', async () => {
    const el = render(
      <HooksInstallPrompt api={apiOf({ getPromptPreference: async () => ({ suppressed: false }) })} t={t} />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-later]') as HTMLButtonElement).click());
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  it('Later is session-scoped only — it never writes the durable preference', async () => {
    const setPromptPreference = vi.fn(async () => ({ suppressed: true }));
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ getPromptPreference: async () => ({ suppressed: false }), setPromptPreference })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-later]') as HTMLButtonElement).click());
    await flush();
    expect(setPromptPreference).not.toHaveBeenCalled();
  });

  it('"Don\'t ask again" persists the refusal and closes', async () => {
    // Stateful on purpose: a mock whose get() keeps answering `false` after a
    // successful write lets a component that never consults the store pass.
    let suppressed = false;
    const setPromptPreference = vi.fn(async (v: boolean) => { suppressed = v; return { suppressed: v }; });
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ getPromptPreference: async () => ({ suppressed }), setPromptPreference })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(setPromptPreference).toHaveBeenCalledWith(true);
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('a stored refusal keeps the prompt down on mount and on re-trigger', async () => {
    const status = vi.fn(async () => ({ installed: false }));
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ status, getPromptPreference: async () => ({ suppressed: true }) })}
        t={t}
      />,
    );
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
    // Suppressed means we never even ask whether hooks are installed.
    expect(status).not.toHaveBeenCalled();

    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('re-reads the preference per trigger, so clearing it in Settings takes effect', async () => {
    let suppressed = true;
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ getPromptPreference: async () => ({ suppressed }) })}
        t={t}
      />,
    );
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    suppressed = false; // the Settings "Ask again" click
    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  // The path the test above does NOT cover, and the one that actually broke: a
  // refusal given IN THIS SESSION must not short-circuit the disk read, or
  // Settings "Ask again" is dead until the next launch.
  it('Settings can reverse a refusal made in the same session', async () => {
    let suppressed = false;
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => ({ suppressed }),
          setPromptPreference: async (v: boolean) => { suppressed = v; return { suppressed: v }; },
        })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    suppressed = false; // Settings -> "Ask again", same process
    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  // Why the last-known cache exists at all. Without it, one failed read after a
  // refusal re-nags the user who already said no.
  it('a read failure after a refusal stands on the last answer instead of asking', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => {
            if (mode === 'throw') throw new Error('EIO');
            return { suppressed: false };
          },
          setPromptPreference: async () => ({ suppressed: true }),
        })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    mode = 'throw';
    act(() => requestHooksInstallPrompt());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  // Two triggers overlap all the time (launch + a mode raise). The loser used
  // to win by resolving last, reopening the modal on top of the answer.
  it('a status probe in flight cannot reopen the modal over a refusal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let call = 0;
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          status: async () => {
            // The second probe resolves only after the user has answered.
            if (++call === 2) await gate;
            return { installed: false };
          },
          getPromptPreference: async () => ({ suppressed: false }),
          setPromptPreference: async () => ({ suppressed: true }),
        })}
        t={t}
      />,
    );
    await flush();
    act(() => requestHooksInstallPrompt()); // second, slow probe starts
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => release());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  // The GET half of the same race. A read that STARTED before the refusal can
  // resolve after it, carrying the pre-refusal value; caching that value would
  // poison the fail-closed fallback and let a LATER failed read re-nag someone
  // who had already refused durably.
  it('a preference read in flight across the refusal cannot poison the cache', async () => {
    let suppressed = false;
    let getCalls = 0;
    let releaseStaleGet!: () => void;
    const staleGet = new Promise<void>((r) => { releaseStaleGet = r; });
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => {
            getCalls += 1;
            // 1: the launch read. 2: the mode-raise read, held open across the
            // click. 3: an IPC hiccup on the next trigger.
            if (getCalls === 2) { await staleGet; return { suppressed: false }; }
            if (getCalls >= 3) throw new Error('EIO');
            return { suppressed };
          },
          setPromptPreference: async (v: boolean) => { suppressed = v; return { suppressed: v }; },
        })}
        t={t}
      />,
    );
    await flush();
    act(() => requestHooksInstallPrompt()); // starts the stale read
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => releaseStaleGet());
    await flush();

    act(() => requestHooksInstallPrompt()); // the read that now fails
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  // Closing the success dialog is a dismissal too. It used to be the one that
  // did not bump the epoch, so an overlapping probe could reopen the nudge on
  // top of a finished install.
  it('a status probe in flight cannot reopen the prompt after install + Close', async () => {
    let statusCalls = 0;
    let releaseStale!: () => void;
    const stale = new Promise<void>((r) => { releaseStale = r; });
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          status: async () => {
            statusCalls += 1;
            if (statusCalls === 2) { await stale; return { installed: false }; }
            return { installed: false };
          },
          getPromptPreference: async () => ({ suppressed: false }),
        })}
        t={t}
      />,
    );
    await flush();
    act(() => requestHooksInstallPrompt()); // starts the stale status probe
    await flush();
    act(() => (el.querySelector('[data-hooks-install]') as HTMLButtonElement).click());
    await flush();
    act(() => (el.querySelector('[data-hooks-close]') as HTMLButtonElement).click());
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => releaseStale());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  // Two reads with no answer between them can resolve out of order. Without a
  // per-request id the OLDER one wins the cache, so a launch read issued before
  // a Settings clear overwrites the fresh answer with its stale one — and the
  // next failed read stands on it and stays quiet when it should ask.
  it('an out-of-order preference read cannot overwrite a newer one', async () => {
    let getCalls = 0;
    let statusCalls = 0;
    let releaseLaunchGet!: () => void;
    const launchGet = new Promise<void>((r) => { releaseLaunchGet = r; });
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => {
            getCalls += 1;
            // 1: the launch read, held open — it saw the PRE-clear `true`.
            if (getCalls === 1) { await launchGet; return { suppressed: true }; }
            // 2: after the Settings clear. 3: an IPC hiccup.
            if (getCalls >= 3) throw new Error('EIO');
            return { suppressed: false };
          },
          status: async () => {
            statusCalls += 1;
            // The second read's own probe finds hooks present, so nothing is
            // shown yet and the assertion below is about the CACHE, not a
            // modal that was already up.
            return { installed: statusCalls === 1 };
          },
        })}
        t={t}
      />,
    );
    await flush();
    act(() => requestHooksInstallPrompt()); // the newer read: suppressed=false
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();

    act(() => releaseLaunchGet()); // the older read lands last, carrying `true`
    await flush();

    act(() => requestHooksInstallPrompt()); // this read fails; falls back to cache
    await flush();
    // The cache must still say "not suppressed", so the fallback asks.
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });

  // What the catch-side epoch guard actually buys: no pointless status probe
  // whose result is already guaranteed to be discarded.
  it('a preference read that fails after a dismissal does not probe status', async () => {
    let getCalls = 0;
    let statusCalls = 0;
    let releaseFailingGet!: () => void;
    const failingGet = new Promise<void>((r) => { releaseFailingGet = r; });
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => {
            getCalls += 1;
            if (getCalls === 2) { await failingGet; throw new Error('EIO'); }
            return { suppressed: false };
          },
          status: async () => { statusCalls += 1; return { installed: false }; },
        })}
        t={t}
      />,
    );
    await flush();
    act(() => requestHooksInstallPrompt()); // starts the read that will fail
    await flush();
    act(() => (el.querySelector('[data-hooks-later]') as HTMLButtonElement).click());
    const before = statusCalls;

    act(() => releaseFailingGet());
    await flush();
    expect(statusCalls).toBe(before);
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('locks out a second action while the refusal is being written', async () => {
    let release!: (v: { suppressed: boolean }) => void;
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => ({ suppressed: false }),
          setPromptPreference: () => new Promise((r) => { release = r; }),
        })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect((el.querySelector('[data-hooks-later]') as HTMLButtonElement).disabled).toBe(true);
    expect((el.querySelector('[data-hooks-install]') as HTMLButtonElement).disabled).toBe(true);
    expect((el.querySelector('[data-hooks-never]') as HTMLButtonElement).disabled).toBe(true);

    act(() => release({ suppressed: true }));
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeNull();
  });

  it('keeps the modal up when the refusal could not be saved', async () => {
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => ({ suppressed: false }),
          setPromptPreference: async () => { throw new Error('EACCES'); },
        })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
    expect(el.querySelector('[data-hooks-error]')?.textContent).toContain('hooks.prompt.neverError');
  });

  it('a write that resolves to not-suppressed is reported, not believed', async () => {
    const el = render(
      <HooksInstallPrompt
        api={apiOf({
          getPromptPreference: async () => ({ suppressed: false }),
          // What main answers when the payload was rejected: the stored value.
          setPromptPreference: async () => ({ suppressed: false }),
        })}
        t={t}
      />,
    );
    await flush();
    act(() => (el.querySelector('[data-hooks-never]') as HTMLButtonElement).click());
    await flush();
    expect(el.querySelector('[data-hooks-error]')?.textContent).toContain('hooks.prompt.neverError');
  });

  it('an older preload is offered no durable button at all', async () => {
    const el = render(<HooksInstallPrompt api={apiOf()} t={t} />);
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
    // Rendering it would promise persistence this preload cannot deliver: the
    // click would silently act as Later and the next launch would ask again.
    expect(el.querySelector('[data-hooks-never]')).toBeNull();
    expect(el.querySelector('[data-hooks-later]')).toBeTruthy();
  });

  it('a preference read failure falls back to asking', async () => {
    const el = render(
      <HooksInstallPrompt
        api={apiOf({ getPromptPreference: async () => { throw new Error('EIO'); } })}
        t={t}
      />,
    );
    await flush();
    expect(el.querySelector('[data-hooks-install-prompt]')).toBeTruthy();
  });
});

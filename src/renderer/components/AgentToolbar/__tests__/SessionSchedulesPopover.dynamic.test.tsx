// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SessionSchedulesPopover, { type SessionSchedulesApi } from '../SessionSchedulesPopover';
import type { SessionPromptSchedule } from '../../../../shared/sessionPromptSchedule';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function schedule(overrides: Partial<SessionPromptSchedule> = {}): SessionPromptSchedule {
  return {
    id: 'schedule-1',
    ptyId: 'pty-codex',
    agentSlug: 'codex',
    prompt: 'continue the milestone',
    nextRunAt: Date.now() + 300_000,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function fakeApi(seed: SessionPromptSchedule[] = []): SessionSchedulesApi & {
  created: Parameters<SessionSchedulesApi['create']>[0][];
  updated: Parameters<SessionSchedulesApi['update']>[0][];
  removed: Array<{ ptyId: string; id: string }>;
} {
  let schedules = [...seed];
  const created: Parameters<SessionSchedulesApi['create']>[0][] = [];
  const updated: Parameters<SessionSchedulesApi['update']>[0][] = [];
  const removed: Array<{ ptyId: string; id: string }> = [];
  return {
    created,
    updated,
    removed,
    list: async (ptyId) => ({ schedules: schedules.filter((item) => item.ptyId === ptyId) }),
    create: async (args) => {
      created.push(args);
      const item = schedule({
        id: `schedule-${created.length + 1}`,
        ...args,
      });
      schedules.push(item);
      return { ok: true, schedule: item };
    },
    update: async (args) => {
      updated.push(args);
      schedules = schedules.map((item) =>
        item.id === args.id && item.ptyId === args.ptyId
          ? { ...item, enabled: args.enabled }
          : item,
      );
      return { ok: true };
    },
    remove: async (ptyId, id) => {
      removed.push({ ptyId, id });
      schedules = schedules.filter((item) => item.id !== id || item.ptyId !== ptyId);
      return { ok: true };
    },
  };
}

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing test element: ${selector}`);
  return element;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native value setter');
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(api: SessionSchedulesApi): Promise<void> {
  await act(async () => {
    root.render(createElement(SessionSchedulesPopover, {
      ptyId: 'pty-codex',
      agentSlug: 'codex',
      agentName: 'Codex CLI',
      api,
    }));
  });
}

describe('SessionSchedulesPopover', () => {
  it('lists only schedules returned for the bound session', async () => {
    await mount(fakeApi([schedule()]));
    expect(container.querySelectorAll('[data-session-schedule-row]')).toHaveLength(1);
    expect(container.textContent).toContain('continue the milestone');
    expect(container.textContent).toContain('Codex CLI · pty-codex');
  });

  it('creates an exact prompt for the immutable PTY and agent target', async () => {
    const api = fakeApi();
    await mount(api);
    const prompt = query<HTMLTextAreaElement>('[data-session-schedule-prompt]');
    await act(async () => { setValue(prompt, 'work through the queued review'); });
    await act(async () => {
      query<HTMLButtonElement>('[data-session-schedule-quick="300"]').click();
    });
    await act(async () => {
      query<HTMLButtonElement>('[data-session-schedule-create]').click();
    });

    expect(api.created).toHaveLength(1);
    expect(api.created[0]).toMatchObject({
      ptyId: 'pty-codex',
      agentSlug: 'codex',
      prompt: 'work through the queued review',
    });
    expect(api.created[0].nextRunAt).toBeGreaterThan(Date.now() + 299 * 60_000);
    expect(container.querySelectorAll('[data-session-schedule-row]')).toHaveLength(1);
  });

  it('rejects a past time before invoking the API', async () => {
    const api = fakeApi();
    await mount(api);
    await act(async () => {
      setValue(query<HTMLTextAreaElement>('[data-session-schedule-prompt]'), 'too late');
      setValue(query<HTMLInputElement>('[data-session-schedule-when]'), '2020-01-01T00:00');
    });
    await act(async () => { query<HTMLButtonElement>('[data-session-schedule-create]').click(); });

    expect(api.created).toHaveLength(0);
    expect(container.querySelector('[data-session-schedule-error]')).not.toBeNull();
  });

  it('pauses and deletes within the bound PTY scope', async () => {
    const api = fakeApi([schedule()]);
    await mount(api);
    await act(async () => { query<HTMLButtonElement>('[data-session-schedule-toggle]').click(); });
    expect(api.updated).toEqual([{ ptyId: 'pty-codex', id: 'schedule-1', enabled: false }]);

    await act(async () => { query<HTMLButtonElement>('[data-session-schedule-delete]').click(); });
    expect(api.removed).toEqual([{ ptyId: 'pty-codex', id: 'schedule-1' }]);
    expect(container.querySelectorAll('[data-session-schedule-row]')).toHaveLength(0);
  });

  it('keeps existing schedules manageable after the agent exits', async () => {
    const api = fakeApi([schedule({ lastResult: 'unavailable' })]);
    await act(async () => {
      root.render(createElement(SessionSchedulesPopover, {
        ptyId: 'pty-codex',
        api,
      }));
    });

    expect(container.querySelectorAll('[data-session-schedule-row]')).toHaveLength(1);
    expect(container.querySelector('[data-session-schedule-needs-agent]')).not.toBeNull();
    expect(query<HTMLButtonElement>('[data-session-schedule-create]').disabled).toBe(true);
    await act(async () => { query<HTMLButtonElement>('[data-session-schedule-delete]').click(); });
    expect(api.removed).toEqual([{ ptyId: 'pty-codex', id: 'schedule-1' }]);
  });
});

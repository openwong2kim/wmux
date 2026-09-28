// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleEditor from '../ScheduleEditor';
import { automation } from './fixtures';
import type { Automation } from '../../../../shared/automation';

let container: HTMLDivElement;
let root: Root;
const api = {
  create: vi.fn(),
  update: vi.fn(),
  grant: vi.fn(),
  setEnabled: vi.fn(),
  runNow: vi.fn(),
  list: vi.fn(async () => ({ automations: [], available: true })),
  runs: vi.fn(async () => ({ runs: [] })),
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  vi.stubGlobal('electronAPI', { automation: api });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const q = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const radio = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!;

function mount(original: Automation | null, onSaved = vi.fn()) {
  act(() => root.render(
    <ScheduleEditor original={original} review={false} accounts={[]} onClose={vi.fn()} onSaved={onSaved} />,
  ));
  return onSaved;
}

describe('ScheduleEditor', () => {
  it('warns before saving an edit that resets a granted permission', () => {
    mount(automation({ permission: { mode: 'bypass', grantedRevision: 3 } }));
    expect(q('[data-schedule-reset-warning]')).toBeNull();
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'A different task'));
    expect(q('[data-schedule-reset-warning]')!.textContent).toContain('resets permission to Approval');
  });

  it('rejects rule patterns in the scoped tool list and never saves them', async () => {
    mount(automation());
    act(() => radio('Scoped').click());
    act(() => type(q<HTMLInputElement>('[data-schedule-tools]')!, 'Read, Bash(git push)'));
    expect(q('[data-schedule-tools-error]')!.textContent).toContain('Bash(git');
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.update).not.toHaveBeenCalled();
  });

  it('grants Bypass after the update at the new revision (main confirms it natively)', async () => {
    const a = automation();
    api.update.mockResolvedValue({ ok: true, automation: { ...a, revision: 4 } });
    api.grant.mockResolvedValue({ ok: true, automation: a });
    const onSaved = mount(a);
    act(() => radio('Bypass').click());
    expect(radio('Bypass').getAttribute('aria-checked')).toBe('true');
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('permission');
    expect(api.grant).toHaveBeenCalledWith('a1', 'bypass', undefined);
    expect(api.update.mock.invocationCallOrder[0]).toBeLessThan(api.grant.mock.invocationCallOrder[0]);
    expect(onSaved).toHaveBeenCalledWith('a1');
  });

  it('hides the tool list for Codex scoped and never sends allowedTools', async () => {
    const a = automation({ action: { kind: 'launch', cwd: '/w', agent: 'codex', prompt: 'p' } });
    api.update.mockResolvedValue({ ok: true, automation: { ...a, revision: 4 } });
    api.grant.mockResolvedValue({ ok: true, automation: a });
    mount(a);
    act(() => radio('Scoped').click());
    expect(q('[data-schedule-tools]')).toBeNull();
    expect(document.body.textContent).toContain('tool list applies to Claude only');
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.grant).toHaveBeenCalledWith('a1', 'scoped', undefined);
  });

  it('creates a scoped schedule disabled atomically, grants, then enables — and a retry never creates twice', async () => {
    const created = automation({ id: 'new1' });
    api.create.mockResolvedValue({ ok: true, automation: created });
    api.setEnabled.mockResolvedValue({ ok: true, automation: created });
    api.grant.mockResolvedValueOnce({ ok: false, error: 'boom' }).mockResolvedValue({ ok: true, automation: created });
    api.update.mockResolvedValue({ ok: true, automation: created });
    const onSaved = mount(null);
    act(() => type(q<HTMLInputElement>('[data-schedule-name]')!, 'Nightly'));
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'Do it'));
    act(() => type(q<HTMLInputElement>('[data-schedule-cwd]')!, '/w'));
    act(() => radio('Scoped').click());
    act(() => type(q<HTMLInputElement>('[data-schedule-tools]')!, 'Read'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0][1]).toBe(false);
    expect(api.setEnabled).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith('new1', expect.anything());
    expect(api.grant).toHaveBeenLastCalledWith('new1', 'scoped', ['Read']);
    expect(api.setEnabled).toHaveBeenLastCalledWith('new1', true);
    expect(onSaved).toHaveBeenCalledWith('new1');
  });

  it('offers no test run while reviewing a draft', () => {
    act(() => root.render(
      <ScheduleEditor original={automation({ proposed: true, enabled: false })} review accounts={[]} onClose={vi.fn()} onSaved={vi.fn()} />,
    ));
    expect(q('[data-schedule-editor-test-run]')).toBeNull();
  });
});

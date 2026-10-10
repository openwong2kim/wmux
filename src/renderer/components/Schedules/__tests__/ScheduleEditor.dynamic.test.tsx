// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleEditor from '../ScheduleEditor';
import { useStore } from '../../../stores';
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

// Permission and the run limits wait behind More options; the folder is in
// its chip's popover.
const openMore = () => act(() => q<HTMLButtonElement>('[data-schedule-more]')!.click());
const openChip = (name: 'schedule' | 'folder' | 'agent') =>
  act(() => q<HTMLButtonElement>(`[data-schedule-chip-${name}]`)!.click());

function mount(original: Automation | null, onSaved = vi.fn()) {
  act(() => root.render(
    <ScheduleEditor original={original} review={false} accounts={[]} onClose={vi.fn()} onSaved={onSaved} />,
  ));
  return onSaved;
}

describe('ScheduleEditor', () => {
  it('grants the same mode again in the save that changes what runs', async () => {
    const a = automation({ permission: { mode: 'auto', grantedRevision: 3 } });
    api.update.mockResolvedValue({ ok: true, automation: { ...a, revision: 4 } });
    api.grant.mockResolvedValue({ ok: true, automation: { ...a, revision: 4 } });
    const onSaved = mount(a);
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'A different task'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.grant).toHaveBeenCalledWith('a1', 'auto', undefined);
    expect(api.update.mock.invocationCallOrder[0]).toBeLessThan(api.grant.mock.invocationCallOrder[0]);
    expect(onSaved).toHaveBeenCalledWith('a1');
  });

  it('says the runs are skipped when the re-grant after a what-runs edit is declined', async () => {
    const a = automation({ permission: { mode: 'auto', grantedRevision: 3 } });
    api.update.mockResolvedValue({ ok: true, automation: { ...a, revision: 4 } });
    api.grant.mockResolvedValue({ ok: false, error: 'cancelled' });
    const onSaved = mount(a);
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'A different task'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(onSaved).not.toHaveBeenCalled();
    expect(q('[data-schedule-error]')!.textContent)
      .toBe("Auto was not granted; this schedule's runs are skipped until you grant it again.");
  });

  it('a renamed schedule keeps its grant without asking again', async () => {
    const a = automation({ permission: { mode: 'auto', grantedRevision: 3 } });
    api.update.mockResolvedValue({ ok: true, automation: a });
    mount(a);
    act(() => type(q<HTMLInputElement>('[data-schedule-name]')!, 'Renamed'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.grant).not.toHaveBeenCalled();
  });

  it('a new schedule defaults to Auto for Claude and Scoped for Codex; Auto is not offered to Codex', () => {
    mount(null);
    openMore();
    expect(radio('Auto').getAttribute('aria-checked')).toBe('true');
    openChip('agent');
    act(() => radio('Codex').click());
    expect(radio('Scoped').getAttribute('aria-checked')).toBe('true');
    expect(radio('Auto')).toBeUndefined();
    act(() => radio('Claude').click());
    expect(radio('Auto').getAttribute('aria-checked')).toBe('true');
  });

  it('rejects rule patterns in the scoped tool list and never saves them', async () => {
    mount(automation());
    openMore();
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
    openMore();
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
    openMore();
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
    openChip('folder');
    act(() => type(q<HTMLInputElement>('[data-schedule-cwd]')!, '/w'));
    openMore();
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

  it('turning on a reviewed agent draft keeps it in Approval (no grant)', async () => {
    const a = automation({ proposed: true, enabled: false });
    api.update.mockResolvedValue({ ok: true, automation: a });
    api.setEnabled.mockResolvedValue({ ok: true, automation: a });
    act(() => root.render(
      <ScheduleEditor original={a} review accounts={[]} onClose={vi.fn()} onSaved={vi.fn()} />,
    ));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.grant).not.toHaveBeenCalled();
    expect(api.setEnabled).toHaveBeenCalledWith('a1', true);
  });

  it('has one primary action and a Cancel — Turn on when reviewing a draft', () => {
    act(() => root.render(
      <ScheduleEditor original={automation({ proposed: true, enabled: false })} review accounts={[]} onClose={vi.fn()} onSaved={vi.fn()} />,
    ));
    expect(q('[data-schedule-editor-test-run]')).toBeNull();
    expect(q('[data-schedule-save]')!.textContent).toBe('Turn on');
    expect([...document.body.querySelectorAll('[data-testid="schedule-editor"] button')]
      .filter((b) => b.className.includes('ui-btn-primary'))).toHaveLength(1);
  });

  it('keeps a new schedule saved and off when its default Auto is declined, with plain copy', async () => {
    const created = automation({ id: 'new2', enabled: false });
    api.create.mockResolvedValue({ ok: true, automation: created });
    api.grant.mockResolvedValue({ ok: false, error: 'cancelled' });
    const onSaved = mount(null);
    act(() => type(q<HTMLInputElement>('[data-schedule-name]')!, 'Nightly'));
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'Do it'));
    openChip('folder');
    act(() => type(q<HTMLInputElement>('[data-schedule-cwd]')!, '/w'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.grant).toHaveBeenCalledWith('new2', 'auto', undefined);
    expect(api.setEnabled).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith('new2');
    expect(useStore.getState().toasts.some((x) => x.message.startsWith('Saved turned off — Auto was not granted'))).toBe(true);
  });

  it('says the permission is unchanged when Bypass is declined on an edit', async () => {
    const a = automation();
    api.update.mockResolvedValue({ ok: true, automation: a });
    api.grant.mockResolvedValue({ ok: false, error: 'cancelled' });
    const onSaved = mount(a);
    openMore();
    act(() => radio('Bypass').click());
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(onSaved).not.toHaveBeenCalled();
    expect(q('[data-schedule-error]')!.textContent)
      .toBe('Bypass was not granted; the schedule keeps its current permission.');
  });

  it('names a new schedule from the prompt\'s first line until the name is typed over', () => {
    mount(null);
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, '\n  Check the nightly build  \nand report'));
    expect(q<HTMLInputElement>('[data-schedule-name]')!.value).toBe('Check the nightly build');
    act(() => type(q<HTMLInputElement>('[data-schedule-name]')!, 'Build check'));
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'Something else'));
    expect(q<HTMLInputElement>('[data-schedule-name]')!.value).toBe('Build check');
  });

  it('sets the schedule from its chip popover and closes it on Escape without leaving', () => {
    const onClose = vi.fn();
    act(() => root.render(<ScheduleEditor original={null} review={false} accounts={[]} onClose={onClose} onSaved={vi.fn()} />));
    const chip = q<HTMLButtonElement>('[data-schedule-chip-schedule]')!;
    expect(chip.textContent).toContain('Weekdays · 09:00');
    openChip('schedule');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    act(() => radio('Weekly').click());
    act(() => type(q<HTMLInputElement>('[data-schedule-time]')!, '07:45'));
    expect(chip.textContent).toContain('Weekly');
    expect(chip.textContent).toContain('07:45');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { q('[data-schedule-time]')!.dispatchEvent(escape); });
    expect(q('[data-schedule-popover]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(true);
  });

  it('Pick days switches the day buttons to multi-select, even from a one-day schedule', () => {
    mount(null);
    openChip('schedule');
    act(() => radio('Weekly').click());
    act(() => radio('Pick days').click());
    const day = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[aria-pressed]')]
      .find((b) => b.textContent === name)!;
    act(() => day('Wed').click());
    act(() => day('Fri').click());
    expect(day('Mon').getAttribute('aria-pressed')).toBe('true');
    expect(day('Wed').getAttribute('aria-pressed')).toBe('true');
    expect(day('Fri').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-schedule-chip-schedule]')!.textContent).toContain('Mon Wed Fri');
  });

  it('shows a missing folder under the chips and keeps More options closed for chip problems', async () => {
    mount(null);
    act(() => type(q<HTMLTextAreaElement>('[data-schedule-prompt]')!, 'Do it'));
    await act(async () => q<HTMLButtonElement>('[data-schedule-save]')!.click());
    expect(api.create).not.toHaveBeenCalled();
    expect(q('[data-schedule-problem="chips"]')!.textContent).toBe('Choose a folder.');
    expect(q('[data-schedule-chip-folder]')!.getAttribute('data-invalid')).toBe('true');
    expect(q('[data-schedule-more-body]')).toBeNull();
  });

  it('keeps every field reachable: model, effort, missed-run window and response limit behind More options', () => {
    mount(automation({ action: { kind: 'launch', cwd: '/w', agent: 'claude', prompt: 'p', model: 'opus', effort: 'high' } }));
    openMore();
    expect(q<HTMLInputElement>('[data-schedule-model]')!.value).toBe('opus');
    expect(q<HTMLInputElement>('[data-schedule-effort]')!.value).toBe('high');
    expect(q<HTMLInputElement>('[data-schedule-grace]')!.value).toBe('180');
    expect(q('[data-schedule-await]')).not.toBeNull();
    openChip('agent');
    expect(q('[data-schedule-popover="agent"] select')).not.toBeNull();
  });
});

// @vitest-environment jsdom
// The Bots profile's model pickers: Change opens the model and effort
// pickers, Save sends the bot's engine or its workers' pick to main, and a
// model id fan-out would refuse is refused here before main is asked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import { en } from '../../../i18n/locales/en';
import { BrainModelLine, WorkerModelLine } from '../BotModelLines';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

function row(over: Partial<BotProfile> = {}): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'moa', template: 'coordinator', name: 'Coordinator',
    engine: { kind: 'claude-sdk', model: 'haiku' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
  return { bot, status: null } as unknown as FactoryBotRow;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as E | null;

function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element | null): Promise<void> {
  await act(async () => { (el as HTMLElement).click(); });
}

describe('Bots profile model pickers', () => {
  it('shows the bot\'s model; Save sends its engine with the picked model and effort', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    act(() => root.render(<BrainModelLine row={row()} t={t} port={{ update }} />));
    expect(q('[data-testid="bots-profile-brain-value"]')?.textContent).toBe('haiku (latest)');
    await click(q('[data-testid="bots-profile-brain-edit"]'));
    type(q<HTMLInputElement>('[data-testid="bots-profile-brain"] input[role="combobox"]')!, 'claude-sonnet-5-5');
    const effort = q<HTMLSelectElement>('[data-testid="bots-profile-brain-effort"]')!;
    act(() => { effort.value = 'high'; effort.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(q('[data-testid="bots-profile-brain-save"]'));
    expect(update).toHaveBeenCalledWith('bot-0000000a', { engine: { kind: 'claude-sdk', model: 'claude-sonnet-5-5', effort: 'high' } });
  });

  it('refuses a model id fan-out would refuse, without asking main', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    act(() => root.render(<BrainModelLine row={row()} t={t} port={{ update }} />));
    await click(q('[data-testid="bots-profile-brain-edit"]'));
    type(q<HTMLInputElement>('[data-testid="bots-profile-brain"] input[role="combobox"]')!, '--dangerously-skip-permissions');
    await click(q('[data-testid="bots-profile-brain-save"]'));
    expect(update).not.toHaveBeenCalled();
    expect(q('[role="alert"]')?.textContent).toMatch(/is not a model id/);
  });

  it('a saved model main would not pass on: the warning stays, the picker opens empty, and an effort-only save sends no model', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    act(() => root.render(<BrainModelLine row={row({ engine: { kind: 'claude-sdk', model: 'opus; rm -rf ~' } })} t={t} port={{ update }} />));
    expect(q('[data-testid="bots-profile-brain-value"]')?.textContent).toBe('Default model');
    expect(q('[data-testid="bots-profile-brain-warning"]')?.textContent).toContain('opus; rm -rf ~');
    await click(q('[data-testid="bots-profile-brain-edit"]'));
    expect(q<HTMLInputElement>('[data-testid="bots-profile-brain"] input[role="combobox"]')!.value).toBe('');
    const effort = q<HTMLSelectElement>('[data-testid="bots-profile-brain-effort"]')!;
    act(() => { effort.value = 'high'; effort.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(q('[data-testid="bots-profile-brain-save"]'));
    expect(update).toHaveBeenCalledWith('bot-0000000a', { engine: { kind: 'claude-sdk', effort: 'high' } });
    expect(q('[role="alert"]')).toBeNull();
  });

  it('a stored model id with padding opens the editor trimmed', async () => {
    act(() => root.render(<BrainModelLine row={row({ engine: { kind: 'claude-sdk', model: '  haiku  ' } })} t={t} port={{ update: vi.fn(async () => ({ ok: true })) }} />));
    await click(q('[data-testid="bots-profile-brain-edit"]'));
    expect(q<HTMLInputElement>('[data-testid="bots-profile-brain"] input[role="combobox"]')!.value).toBe('haiku');
  });

  it('the workers\' model: a model alone pins Claude workers on it; main\'s refusal is shown', async () => {
    const update = vi.fn(async () => ({ ok: false, message: 'workerAgent: refused by main' }));
    act(() => root.render(<WorkerModelLine row={row({ engine: { kind: 'claude-sdk' } })} t={t} port={{ update }} />));
    expect(q('[data-testid="bots-profile-worker-model-value"]')?.textContent).toBe('Default model');
    await click(q('[data-testid="bots-profile-worker-model-edit"]'));
    type(q<HTMLInputElement>('[data-testid="bots-profile-worker-model"] input[role="combobox"]')!, 'opus');
    await click(q('[data-testid="bots-profile-worker-model-save"]'));
    expect(update).toHaveBeenCalledWith('bot-0000000a', { workerAgent: { agent: 'claude', model: 'opus' } });
    expect(q('[role="alert"]')?.textContent).toBe('workerAgent: refused by main');
  });

  it('a profile without update shows the models read-only', () => {
    act(() => root.render(<WorkerModelLine row={row({ workerAgent: { agent: 'claude', model: 'opus', effort: 'max' } })} t={t} />));
    expect(q('[data-testid="bots-profile-worker-model-value"]')?.textContent).toBe('opus (latest) · max effort');
    expect(q('[data-testid="bots-profile-worker-model-edit"]')).toBeNull();
  });
});

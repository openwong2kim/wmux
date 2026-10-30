// @vitest-environment jsdom
// A bot's settings page: every setting the profile popover and the Settings
// › Bots row editor held is on it and saves through the same call (one
// bot.update patch, then setAvatar, then the commands switch) with one Save;
// a My Hermes bot's page leaves out what does not apply and says what it can
// really do; and leaving with unsaved changes asks first.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { en } from '../../../i18n/locales/en';
import { DEFAULT_BOT_BUDGETS, myHermesEngine, type BotProfile } from '../../../../shared/bot';
import type { BotCommandReadResult } from '../../../../shared/botCommand';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { setBotCommandPort, type BotCommandPort } from '../BotCommands';
import { BotSettingsPage, botSettingsSections, type BotSettingsPort } from '../BotSettingsPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

const ID = 'bot-0000000a';
const PNG = 'data:image/png;base64,AAAA';

function row(over: Partial<BotProfile> = {}): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id: ID, workspaceId: 'ws-1', role: 'lead', template: 'developer', name: 'Dev', job: 'Ship features.',
    engine: { kind: 'claude-sdk', model: 'haiku' }, triggers: [{ kind: 'pr.opened' }, { kind: 'ci.failed' }],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
    repo: { repoKey: 'github.com/acme/app', repoPath: '/src/app' }, ...over,
  };
  return { bot, status: { botId: ID, presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: null, turnsDay: 190, workerHoursDay: 6 } } };
}

function commandPort(enabled = true): BotCommandPort & { setEnabled: ReturnType<typeof vi.fn> } {
  return {
    available: true,
    read: async (): Promise<BotCommandReadResult> => ({ ok: true, available: true, enabled, entries: [], rules: [] }),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    allow: vi.fn(async () => ({ ok: true as const })),
    removeRule: vi.fn(async () => ({ ok: true as const })),
  };
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
  setBotCommandPort(null);
});

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as E | null;

async function type(sel: string, value: string): Promise<void> {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel)!;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(sel: string, value: string): Promise<void> {
  const el = q<HTMLSelectElement>(sel)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function mount(r: FactoryBotRow, port: BotSettingsPort, extra: { onBack?: () => void; onDirtyChange?: (d: boolean) => void } = {}): Promise<void> {
  await act(async () => root.render(
    <BotSettingsPage
      row={r}
      workers={[]}
      workspaceName="App"
      t={t}
      port={port}
      stopPort={{ stopBot: vi.fn(), newConversation: vi.fn() }}
      onBack={extra.onBack ?? (() => undefined)}
      onDirtyChange={extra.onDirtyChange ?? (() => undefined)}
      leaveAsk={null}
      pickFolder={async () => '/src/app-2'}
    />,
  ));
  // The commands view and the engines are read after the first render.
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

describe('BotSettingsPage', () => {
  it('holds every setting of the bot and saves the form fields with one Save, through the calls the profile and the Settings row used', async () => {
    const commands = commandPort(true);
    setBotCommandPort(commands);
    const update = vi.fn(async () => ({ ok: true }));
    const setAvatar = vi.fn(async () => ({ ok: true as const, bot: row().bot }));
    const port: BotSettingsPort = {
      update,
      setAvatar,
      pickAvatar: vi.fn(async () => ({ ok: true as const, avatar: PNG })),
      act: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      workerAgents: vi.fn(async () => [{ agent: 'codex', label: 'Codex', installed: true, supported: true }]),
    };
    await mount(row(), port);

    // The sections, in the nav and on the page.
    expect([...host.querySelectorAll('[data-bot-settings-nav]')].map((b) => b.textContent)).toEqual(
      ['Basics', 'Engine', 'Work', 'Limits', 'Connections', 'Memory & skills', 'What it can do', 'Stop or remove'],
    );
    // Read-only facts: workspace, engine, what wakes it in words.
    expect(q('[data-bot-settings-workspace]')?.textContent).toBe('App');
    expect(q('[data-bots-profile-engine]')).not.toBeNull();
    expect(q('[data-bot-settings-wakes]')?.textContent).toBe('Your messages and other bots\' handoffs · pull requests in its repository · CI results');
    // The status strip: state, today's turns and the one Pause.
    expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Idle');
    expect(q('.wmux-bot-settings-strip')?.textContent).toContain(`Today: ${DEFAULT_BOT_BUDGETS.lead.maxTurnsPerDay - 190} of ${DEFAULT_BOT_BUDGETS.lead.maxTurnsPerDay} turns`);
    expect(q('[data-bots-today-line="workerTime"]')).not.toBeNull();
    // Stop or remove.
    expect(q('[data-testid="bots-new-conversation"]')).not.toBeNull();
    expect(q('[data-testid="bots-stop-bot"]')).not.toBeNull();
    expect(q('[data-testid="bots-delete-bot"]')).not.toBeNull();

    const save = () => q<HTMLButtonElement>('[data-testid="bot-settings-save"]')!;
    expect(save().disabled).toBe(true);
    expect(q('[data-bot-settings-foot]')?.textContent).toContain('Changes apply from the bot\'s next turn.');

    await type('[data-testid="bot-settings-name"]', 'Builder');
    await act(async () => q<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    await type('[data-testid="bots-profile-job-input"]', 'Fix bugs.');
    await act(async () => q<HTMLButtonElement>('[data-testid="bots-profile-repo-change"]')!.click());
    await type('[data-testid="bot-settings-perDay"]', '50');
    await type('[data-testid="bot-settings-perHour"]', '');
    await type('[data-testid="bot-settings-perHour"]', '8');
    await type('[data-testid="bot-settings-workers"]', '2');
    await type('[data-testid="bots-profile-brain"] input[role="combobox"]', 'sonnet');
    await choose('[data-testid="bots-profile-brain-effort"]', 'high');
    await choose('[data-testid="bots-profile-workers-engine"]', 'codex');
    await type('[data-testid="bots-profile-worker-model"] input[role="combobox"]', 'gpt-5');
    await act(async () => q<HTMLButtonElement>('[data-testid="bot-commands-switch"]')!.click());
    // Nothing is sent before Save.
    expect(update).not.toHaveBeenCalled();
    expect(setAvatar).not.toHaveBeenCalled();
    expect(commands.setEnabled).not.toHaveBeenCalled();
    expect(save().disabled).toBe(false);

    await act(async () => save().click());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(ID, {
      name: 'Builder',
      job: 'Fix bugs.',
      repoFolder: '/src/app-2',
      budget: { maxTurnsPerHour: 8, maxTurnsPerDay: 50, maxConcurrentWorkers: 2 },
      engine: { kind: 'claude-sdk', model: 'sonnet', effort: 'high' },
      workerAgent: { agent: 'codex', model: 'gpt-5' },
    });
    expect(setAvatar).toHaveBeenCalledWith(ID, PNG);
    expect(commands.setEnabled).toHaveBeenCalledWith({ botId: ID, enabled: false });
    expect(save().disabled).toBe(true);
  });

  it('refuses a model id main would refuse without asking it, and shows main\'s own refusal in the footer', async () => {
    const update = vi.fn(async () => ({ ok: false, message: 'budget: refused by main' }));
    await mount(row(), { update });
    await type('[data-testid="bots-profile-brain"] input[role="combobox"]', '--dangerously-skip-permissions');
    await act(async () => q<HTMLButtonElement>('[data-testid="bot-settings-save"]')!.click());
    expect(update).not.toHaveBeenCalled();
    expect(q('[data-bot-settings-foot] [role="alert"]')?.textContent).toMatch(/is not a model id/);
    await type('[data-testid="bots-profile-brain"] input[role="combobox"]', 'haiku');
    await type('[data-testid="bot-settings-perDay"]', '10');
    await act(async () => q<HTMLButtonElement>('[data-testid="bot-settings-save"]')!.click());
    expect(update).toHaveBeenCalledWith(ID, { budget: { maxTurnsPerDay: 10 } });
    expect(q('[data-bot-settings-foot] [role="alert"]')?.textContent).toBe('budget: refused by main');
    // A refused profile keeps the owner's changes.
    expect(q<HTMLInputElement>('[data-testid="bot-settings-perDay"]')!.value).toBe('10');
  });

  it('Cancel drops the changes; the dirty state is reported for the leave guard', async () => {
    const dirty: boolean[] = [];
    await mount(row(), { update: vi.fn(async () => ({ ok: true })) }, { onDirtyChange: (d) => dirty.push(d) });
    await type('[data-testid="bot-settings-name"]', 'Other');
    expect(dirty.at(-1)).toBe(true);
    await act(async () => q<HTMLButtonElement>('[data-testid="bot-settings-cancel"]')!.click());
    expect(q<HTMLInputElement>('[data-testid="bot-settings-name"]')!.value).toBe('Dev');
    expect(dirty.at(-1)).toBe(false);
    // Typing the old value back is no change either.
    await type('[data-testid="bot-settings-name"]', 'Dev');
    expect(q<HTMLButtonElement>('[data-testid="bot-settings-save"]')!.disabled).toBe(true);
  });

  it('a bot that is off shows Off and Turn on, which turns it on at once', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    await mount(row({ enabled: false }), { update, act: vi.fn(async () => ({ ok: true })) });
    expect(q('[data-bots-profile-state]')?.textContent).toBe('Off');
    await act(async () => q<HTMLButtonElement>('[data-testid="bots-turn-on-bot"]')!.click());
    expect(update).toHaveBeenCalledWith(ID, { enabled: true });
  });

  it('the status strip reads as one state, and Pause is only in the strip', async () => {
    const r = row();
    await mount(r, { update: vi.fn(async () => ({ ok: true })), act: vi.fn(async () => ({ ok: true })) });
    expect(host.querySelectorAll('[data-testid="bots-pause-bot"]')).toHaveLength(1);
    expect(q('[data-bot-settings-section="remove"] [data-testid="bots-pause-bot"]')).toBeNull();
    expect(q('[data-bot-settings-nav="remove"]')?.textContent).toBe('Stop or remove');
    await mount(row({ parked: { reason: 'human', at: 1 } }), { act: vi.fn(async () => ({ ok: true })) });
    expect(q('[data-bots-profile-state]')?.textContent).toBe('Paused by you');
    expect(q('.wmux-bot-settings-strip')?.textContent).not.toMatch(/On ·|Parked/);
    expect(q('[data-testid="bots-resume-bot"]')).not.toBeNull();
    await mount(row({ parked: { reason: 'error', at: 1 } }), { act: vi.fn(async () => ({ ok: true })) });
    expect(q('[data-bots-profile-state]')?.textContent).toBe('Parked');
    expect(q('[data-bots-profile-parked="error"]')?.textContent).toContain('Stopped after errors');
    await mount(row({ enabled: false }), {});
    expect(q('[data-bots-profile-state]')?.textContent).toBe('Off');
  });

  it('a My Hermes bot leaves out Work and Connections and lists only what it can really do', async () => {
    const mine = row({ engine: myHermesEngine(), template: 'custom', job: undefined });
    expect(botSettingsSections(mine)).toEqual(['basics', 'engine', 'limits', 'memory', 'canDo', 'remove']);
    await mount(mine, { update: vi.fn(async () => ({ ok: true })), workerAgents: vi.fn(async () => []) });
    expect(q('[data-bot-settings-section="work"]')).toBeNull();
    expect(q('[data-bot-settings-section="connections"]')).toBeNull();
    expect(q('[data-testid="bots-profile-workers-engine"]')).toBeNull();
    expect(q('[data-bot-settings-nav="work"]')).toBeNull();
    // Its engine's readiness stays in Engine; its model is its Hermes's.
    expect(q('[data-bot-settings-section="engine"] [data-bots-profile-engine]')).not.toBeNull();
    expect(q('[data-testid="bots-profile-brain-value"]')?.textContent).toBe(en['botsPage.models.myHermesModel']);
    const canDo = [...host.querySelectorAll('[data-can-do]')].map((el) => el.textContent);
    expect(canDo).toEqual([en['botsPage.canDo.myHermesTalk'], en['botsPage.canDo.myHermesTools']]);
    expect(canDo).not.toContain(en['botsPage.canDo.fanout']);
    expect(q('[data-cannot-do]')?.textContent).toBe(en['botsPage.canDo.myHermesCannot']);
    // No worker figures anywhere: it starts no wmux workers.
    expect(q('.wmux-bot-settings-strip')?.textContent).not.toMatch(/Worker/);
    expect(q('[data-bots-today-line="workerTime"]')).toBeNull();
    expect(q('[data-bots-today-line="workers"]')).toBeNull();
    expect(q('[data-testid="bot-settings-workers"]')).toBeNull();
  });

  it('the bots off: nothing edits, Delete bot stays', async () => {
    await mount(row(), { update: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) });
    await act(async () => root.render(
      <BotSettingsPage row={row()} workers={[]} workspaceName="App" t={t} port={{ remove: vi.fn(async () => ({ ok: true })) }} stopPort={{}} readOnly onBack={() => undefined} onDirtyChange={() => undefined} leaveAsk={null} />,
    ));
    expect(q<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);
    expect(q('[data-bot-settings-foot]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="bots-delete-bot"]')!.disabled).toBe(false);
  });
});

describe('openBotSettings', () => {
  it('asks the Bots page for that bot\'s settings page', () => {
    act(() => useStore.setState({ roomStatus: { running: true, enabled: true, hqWorkspaceId: null } } as never));
    act(() => useStore.getState().openBotSettings(ID));
    expect(useStore.getState().botsSettingsAsk?.botId).toBe(ID);
    expect(useStore.getState().appRoute).toBe('bots');
  });
});

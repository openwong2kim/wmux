// @vitest-environment jsdom
// @wmux-lane unit
// 'win32' here is only the platform prop the checklist is given; nothing
// reads the OS.
// Bot recipes: every recipe's text exists in en, ko, pl and zh and makes a
// job the bot store keeps; Add bot's Recipe select prefills the job and
// sends the recipe with its template; the profile's checklist shows each
// connection's state and links to Plugins › Connectors.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { getLocale, setLocale, t, type Locale } from '../../../i18n';
import { en } from '../../../i18n/locales/en';
import { ko } from '../../../i18n/locales/ko';
import { pl } from '../../../i18n/locales/pl';
import { zh } from '../../../i18n/locales/zh';
import { BOT_RECIPES, botRecipe, recipeConnectorName } from '../../../../shared/botRecipes';
import { normalizeBotJob } from '../../../../shared/bot';
import { CONNECTOR_SERVICES, serviceConnectorDraft } from '../../../../shared/connectorServices';
import type { ConnectorView } from '../../../../shared/botConnector';
import type { ConnectorOAuthStatus } from '../../../../shared/connectorOAuth';
import type { FactoryBotCreateRequest } from '../../../../shared/botCreate';
import { setFactoryBotPort, type FactoryBotPort } from '../../Room/factoryPorts';
import type { BotConnectorPort } from '../../Room/botConnectors';
import { AddBotForm } from '../../Settings/FactoryTab';
import { BotRecipeChecklist, recipeJob, signedInOf } from '../BotRecipes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOT = 'bot-0000000a';
const LOCALES: Record<string, Record<string, string>> = { en, ko, pl, zh };

describe('the recipe catalog in every shipped language', () => {
  const was = getLocale();
  afterEach(() => setLocale(was));

  it('has each recipe\'s title, hint and job, and the shared lines, in en, ko, pl and zh', () => {
    const keys = [
      'botRecipes.common.work', 'botRecipes.common.refused',
      'botsPage.profile.recipeState.ready', 'botsPage.profile.recipeState.readyKey', 'botsPage.profile.recipeReadyNote',
      ...BOT_RECIPES.flatMap((r) => [r.titleKey, r.hintKey, r.jobKey]),
    ];
    for (const [loc, dict] of Object.entries(LOCALES)) {
      for (const key of keys) expect(dict[key], `${loc} ${key}`).toBeTruthy();
    }
  });

  it('makes a job the bot store keeps, naming its connections and offering no schedule, in every language', () => {
    for (const loc of Object.keys(LOCALES) as Locale[]) {
      setLocale(loc);
      for (const r of BOT_RECIPES) {
        const job = recipeJob(r, t);
        expect(normalizeBotJob(job), `${loc} ${r.id}`).toBe(job);
        expect(job).toContain('"research"');
        // A gated worker has no built-in file tools: its files go through Bash.
        expect(job).toContain('Bash');
        expect(job).not.toMatch(/\{[a-z]+\}/);
        for (const id of r.connectors) expect(job).toContain(recipeConnectorName(id));
        expect(job.split('\n\n')).toHaveLength(3);
        expect(job).not.toMatch(/routine|09:00/i);
      }
    }
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setFactoryBotPort({ subscribe: () => () => undefined } as unknown as FactoryBotPort);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFactoryBotPort(null);
});

function connector(id: string, over: Partial<ConnectorView>): ConnectorView {
  const s = CONNECTOR_SERVICES.find((x) => x.id === id)!;
  return { ...serviceConnectorDraft(s), id: over.id ?? 'con-000000a1', name: s.id, offFor: [], createdAt: 1, updatedAt: 1, missingKeys: [], ...over };
}

function connectorPort(list: ConnectorView[]): BotConnectorPort {
  return {
    available: true,
    list: async () => ({ ok: true, connectors: list }),
    save: vi.fn(), remove: vi.fn(), setOffForBot: vi.fn(), setEnabled: vi.fn(),
  } as unknown as BotConnectorPort;
}

describe('BotRecipeChecklist', () => {
  it('shows where each connection stands and links every state to Plugins › Connectors', async () => {
    const calendar = connector('google-calendar', { id: 'con-000000c1', enabled: true, scope: { kind: 'bots', botIds: [BOT] }, tools: { mode: 'listed', allowed: ['list_events'] } });
    const gmail = connector('gmail', { id: 'con-000000c2', enabled: true });
    const statuses: Record<string, ConnectorOAuthStatus> = { 'con-000000c1': 'authorized', 'con-000000c2': 'signed-out' };
    const oauthStatus = vi.fn(async (_a: 'status', id: string) => ({ status: statuses[id] }));
    const bot = { id: BOT, recipe: 'meetingPrep', template: 'custom' as const, role: 'lead' as const };
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={connectorPort([calendar, gmail])} oauthStatus={oauthStatus} platform="darwin" />));
    const state = (id: string) => host.querySelector(`[data-recipe-connector="${id}"]`)?.getAttribute('data-state');
    expect(state('google-calendar')).toBe('ready');
    expect(host.querySelector('[data-testid="bot-recipe-state-google-calendar"]')!.textContent).toBe(en['botsPage.profile.recipeState.ready']);
    expect(host.querySelector('[data-recipe-ready-note]')).not.toBeNull();
    expect(state('gmail')).toBe('signIn');
    expect(host.textContent).toContain(en['botRecipes.meetingPrep.title']);
    expect(host.querySelector('[data-testid="bot-recipe-state-gmail"]')!.textContent).toBe(`${en['botsPage.profile.recipeState.signIn']} · ${en['botsPage.profile.recipeOwnClient']}`);
    useStore.setState({ appRoute: 'workspaces', pluginsSelection: null } as never);
    await act(async () => (host.querySelector('[data-testid="bot-recipe-state-gmail"]') as HTMLButtonElement).click());
    expect(useStore.getState().appRoute).toBe('plugins');
    expect(useStore.getState().pluginsSelection).toBe('connectors');
  });

  it('reads "Checking…" until the library is read, never a sign-in it has not seen', async () => {
    let answer: (r: { ok: true; connectors: ConnectorView[] }) => void = () => undefined;
    const port = { ...connectorPort([]), list: () => new Promise((resolve) => { answer = resolve; }) } as unknown as BotConnectorPort;
    const bot = { id: BOT, recipe: 'notionMeetingDigest', template: 'custom' as const, role: 'lead' as const };
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={port} oauthStatus={vi.fn()} platform="darwin" />));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('checking');
    expect(host.textContent).not.toContain(en['botsPage.profile.recipeState.signIn']);
    await act(async () => answer({ ok: true, connectors: [] }));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('signIn');
  });

  it('reads a sign-in in flight again until it settles, and without the sign-in bridge says sign in needed instead of checking', async () => {
    vi.useFakeTimers();
    try {
      const c = connector('notion', { id: 'con-000000d1', enabled: true, scope: { kind: 'bots', botIds: [BOT] }, tools: { mode: 'listed', allowed: ['notion-search'] } });
      const answers: ConnectorOAuthStatus[] = ['authorizing', 'authorized'];
      const oauthStatus = vi.fn(async () => ({ status: answers.shift() ?? 'authorized' }));
      const bot = { id: BOT, recipe: 'notionMeetingDigest', template: 'custom' as const, role: 'lead' as const };
      await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={connectorPort([c])} oauthStatus={oauthStatus} platform="darwin" />));
      expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('checking');
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(oauthStatus).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('ready');
      act(() => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={connectorPort([c])} oauthStatus={undefined} platform="darwin" />));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('signIn');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads an expired access token as signed in: main refreshes it when a worker starts', async () => {
    const c = connector('notion', { id: 'con-000000e1', enabled: true, scope: { kind: 'bots', botIds: [BOT] }, tools: { mode: 'listed', allowed: ['notion-search'] } });
    const oauthStatus = vi.fn(async () => ({ status: 'expired' as ConnectorOAuthStatus }));
    const bot = { id: BOT, recipe: 'notionMeetingDigest', template: 'custom' as const, role: 'lead' as const };
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={connectorPort([c])} oauthStatus={oauthStatus} platform="darwin" />));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('ready');
    expect(signedInOf('expired')).toBe(true);
    expect(signedInOf('signed-out')).toBe(false);
    expect(signedInOf('authorizing')).toBeUndefined();
  });

  it('a library that cannot be read reads as empty, never "Checking…" for good', async () => {
    const bot = { id: BOT, recipe: 'notionMeetingDigest', template: 'custom' as const, role: 'lead' as const };
    const refused = { ...connectorPort([]), list: async () => ({ ok: false, code: 'not_started', message: 'x' }) } as unknown as BotConnectorPort;
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={refused} oauthStatus={vi.fn()} platform="darwin" />));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('signIn');
    const rejected = { ...connectorPort([]), list: async () => { throw new Error('gone'); } } as unknown as BotConnectorPort;
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={rejected} oauthStatus={vi.fn()} platform="darwin" />));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('signIn');
  });

  it('says macOS and Linux only on Windows, and nothing for a bot without a recipe or no longer of its template', async () => {
    const bot = { id: BOT, recipe: 'notionMeetingDigest', template: 'custom' as const, role: 'lead' as const };
    await act(async () => root.render(<BotRecipeChecklist bot={bot} t={t} port={connectorPort([])} oauthStatus={vi.fn()} platform="win32" />));
    expect(host.querySelector('[data-recipe-connector="notion"]')?.getAttribute('data-state')).toBe('platform');
    expect(host.textContent).toContain(en['botsPage.profile.recipeState.platform']);
    await act(async () => root.render(<BotRecipeChecklist bot={{ ...bot, recipe: undefined }} t={t} port={connectorPort([])} oauthStatus={vi.fn()} />));
    expect(host.querySelector('[data-bots-profile-recipe]')).toBeNull();
    await act(async () => root.render(<BotRecipeChecklist bot={{ ...bot, template: 'researcher' }} t={t} port={connectorPort([])} oauthStatus={vi.fn()} />));
    expect(host.querySelector('[data-bots-profile-recipe]')).toBeNull();
  });
});

describe('Add bot\'s Recipe select', () => {
  it('a template chip pressed after a recipe sends that template and no recipe', async () => {
    const create = vi.fn(async (_req: FactoryBotCreateRequest) => ({ ok: false as const, code: 'invalid_argument' as const, message: 'stop' }));
    const port = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create } as unknown as FactoryBotPort;
    await act(async () => root.render(<AddBotForm t={t} port={port} rows={[]} workspaces={[{ id: 'ws-a', name: 'App' }] as never} defaultWorkspaceId="ws-a" pickFolder={async () => null} onDone={() => undefined} />));
    const select = host.querySelector('[data-testid="factory-add-bot-recipe"]') as HTMLSelectElement;
    await act(async () => { select.value = 'githubWeek'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => (host.querySelector('[data-template="developer"]') as HTMLButtonElement).click());
    expect(select.value).toBe('');
    const name = host.querySelector('[data-testid="factory-add-bot-name"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Dev');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('[data-testid="factory-add-bot-submit"]') as HTMLButtonElement).click());
    const req = create.mock.calls[0][0];
    expect(req.template).toBe('developer');
    expect(req).not.toHaveProperty('recipe');
    expect(req.job).toBe(t('botsPage.templateJob.developer'));
  });

  it('prefills the job, clears a template chip, and sends the recipe with its template', async () => {
    const create = vi.fn(async (_req: FactoryBotCreateRequest) => ({ ok: false as const, code: 'invalid_argument' as const, message: 'stop' }));
    const port = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create } as unknown as FactoryBotPort;
    await act(async () => root.render(<AddBotForm t={t} port={port} rows={[]} workspaces={[{ id: 'ws-a', name: 'App' }] as never} defaultWorkspaceId="ws-a" pickFolder={async () => null} onDone={() => undefined} />));
    const select = host.querySelector('[data-testid="factory-add-bot-recipe"]') as HTMLSelectElement;
    const job = () => (host.querySelector('[data-testid="factory-add-bot-job"]') as HTMLTextAreaElement).value;
    // A template chip first: picking a recipe unpresses it and replaces its prefill.
    const chip = host.querySelector('[data-template="researcher"]') as HTMLButtonElement;
    await act(async () => chip.click());
    await act(async () => { select.value = 'notionMeetingDigest'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(job()).toBe(recipeJob(botRecipe('notionMeetingDigest')!, t));
    expect(host.querySelector('[data-testid="factory-add-bot-recipe-note"]')!.textContent).toContain('Notion');
    const name = host.querySelector('[data-testid="factory-add-bot-name"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Notes');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('[data-testid="factory-add-bot-submit"]') as HTMLButtonElement).click());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Notes', template: 'custom', recipe: 'notionMeetingDigest', job: job() }));
  });
});

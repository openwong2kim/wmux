// @vitest-environment jsdom
//
// A new owner's path to a first bot: the composer offers the bots of this
// room as chips (and points to Settings › Factory when there are none),
// "Add bot" adds a bot by name (a template chip prefills its job; the
// repository is optional: inherited, suggested by main, or a picked folder),
// and the HQ strip keeps every bot's name whole.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { BotProfile } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import { MentionChips, RoomComposer, roomBots, roomLead } from '../RoomComposer';
import { BotChips } from '../BotChips';
import { en } from '../../../i18n/locales/en';
import { AddBotForm, FactoryTab, addBotRepoView, repoKeyLabel } from '../../Settings/FactoryTab';
import type { FactoryBotPort, FactoryBotRow } from '../factoryPorts';
import type { FactoryBotCreateRequest, FactoryBotCreateResult, FactoryBotCreateTeamRequest, FactoryBotCreateTeamResult, FactoryBotRepoSuggestion } from '../../../../shared/botCreate';

const WS = 'ws-a';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
}

/** Type into a React-controlled field by its test id. */
async function typeInto(testId: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)!;
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function row(id: string, over: Partial<BotProfile> = {}): FactoryBotRow {
  return {
    bot: {
      version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
      budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, ...over,
    },
    status: null,
  };
}

describe('roomBots', () => {
  it('lists the enabled bots of this workspace, oldest first', () => {
    const bots = [
      row('bot-00000001', { role: 'verifier', createdAt: 5 }),
      row('bot-00000002', { role: 'lead', enabled: false }),
      row('bot-00000003', { role: 'triage', workspaceId: 'ws-b' }),
      row('bot-00000004', { role: 'moa', workspaceId: 'ws-hq' }),
      row('bot-00000005', { role: 'lead', createdAt: 2 }),
    ];
    expect(roomBots(bots, WS).map((r) => r.bot.id)).toEqual(['bot-00000005', 'bot-00000001']);
    expect(roomBots(bots, 'ws-b').map((r) => r.bot.id)).toEqual(['bot-00000003']);
    expect(roomBots([], WS)).toEqual([]);
  });
});

describe('RoomComposer without a bot here', () => {
  it('shows no chips, one line, and a button to Settings › Factory; the box stays usable', async () => {
    const onAddBot = vi.fn();
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [row('bot-00000001', { workspaceId: 'ws-b' })], t, api: null, onAddBot }));
    expect(container.querySelector('[data-testid="room-composer-bot"]')).toBeNull();
    expect(container.querySelector('[data-testid="room-composer-no-bots"]')?.textContent).toContain('room.composer.noBots');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-add-bot"]')!.click());
    expect(onAddBot).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!.disabled).toBe(false);
  });

  it('a picked chip whose bot goes away stays shown and addressed (never redirected)', async () => {
    const post = vi.fn(async () => ({ ok: true, card: { id: 'c1' }, addressee: null }));
    const api = { post } as never;
    const verifier = row('bot-00000001', { role: 'verifier' });
    const lead = row('bot-00000002', { role: 'lead' });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [verifier, lead], t, api }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-bot-id="bot-00000001"]')!.click());
    // Switched off meanwhile: the chip stays picked; main says it reached nobody.
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [{ ...verifier, bot: { ...verifier.bot, enabled: false } }, lead], t, api }));
    expect(container.querySelector('[data-bot-id="bot-00000001"]')?.getAttribute('aria-pressed')).toBe('true');
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'check it');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ mentions: ['bot-00000001'] }));
  });

  it('with bots here, shows their chips (any template, several)', async () => {
    const bots = [row('bot-00000001', { role: 'lead' }), row('bot-00000003', { role: 'lead', createdAt: 3 }), row('bot-00000002', { role: 'moa', workspaceId: 'ws-hq' })];
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots, t, api: null }));
    const ids = [...container.querySelectorAll('[data-testid="room-composer-bot"]')].map((b) => b.getAttribute('data-bot-id'));
    expect(ids).toEqual(['bot-00000001', 'bot-00000003']);
    expect(container.querySelector('[data-testid="room-composer-no-bots"]')).toBeNull();
  });
});

describe('FactoryTab › Add bot', () => {
  const view = {
    version: 1 as const, enabled: true, hqWorkspaceId: 'ws-hq', trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
    verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
  };

  function setup(result: FactoryBotCreateResult, rows: FactoryBotRow[] = []) {
    const create = vi.fn(async (_req: FactoryBotCreateRequest) => result);
    const botPort: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }), create };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async () => view) };
    const pickFolder = vi.fn(async () => '/src/app');
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }, { id: 'ws-hq', name: 'HQ' }] as never, activeWorkspaceId: WS });
    return { create, botPort, settingsPort, pickFolder };
  }

  it('from "No bots yet.": a name is all it takes; the folder is optional', async () => {
    const { create, botPort, settingsPort, pickFolder } = setup({ ok: true, bot: row('bot-00000001').bot });
    await render(createElement(FactoryTab, { settingsPort, botPort, pickFolder }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-open"]')!.click());
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    // No name, no Add; a role picker is gone.
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('[data-testid="factory-add-bot-role"]')).toBeNull();
    await typeInto('factory-add-bot-name', '  Wmux Issue ');
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: 'Wmux Issue' });
    expect(container.querySelector('[data-testid="factory-add-bot"]')).toBeNull();
  });

  it('a template chip prefills the job; a job the owner wrote stays; the chip and job are sent', async () => {
    const { create, botPort, settingsPort, pickFolder } = setup({ ok: true, bot: row('bot-00000001').bot });
    await render(createElement(FactoryTab, { settingsPort, botPort, pickFolder }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-open"]')!.click());
    const chips = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-add-bot-template"]')];
    expect(chips.map((c) => c.getAttribute('data-template'))).toEqual(['coordinator', 'developer', 'reviewer', 'issue', 'researcher']);
    const job = () => container.querySelector<HTMLTextAreaElement>('[data-testid="factory-add-bot-job"]')!.value;
    await act(async () => chips[3].click());
    expect(chips[3].getAttribute('aria-pressed')).toBe('true');
    expect(job()).toBe(en['botsPage.templateJob.issue']);
    // Another chip replaces its own prefill …
    await act(async () => chips[0].click());
    expect(job()).toBe(en['botsPage.templateJob.coordinator']);
    // … but never the owner's words.
    await typeInto('factory-add-bot-job', 'Lead the team and merge what is ready.');
    await act(async () => chips[1].click());
    expect(job()).toBe('Lead the team and merge what is ready.');
    await typeInto('factory-add-bot-name', '대장');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: '대장', template: 'developer', job: 'Lead the team and merge what is ready.' });
  });

  it('a pasted command or path is not a name: Add stays off and the form says why', async () => {
    const { botPort, settingsPort, pickFolder, create } = setup({ ok: true, bot: row('bot-00000001').bot });
    await render(createElement(FactoryTab, { settingsPort, botPort, pickFolder }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-open"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    const submit = () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    const blocked = () => container.querySelector('[data-testid="factory-add-bot-blocked"]')?.textContent ?? null;
    await typeInto('factory-add-bot-name', 'cd /private/tmp/wmux-e2e && npm run dev');
    expect(submit().disabled).toBe(true);
    expect(blocked()).toBe(en['settings.factory.addBotBadName'].replace('{max}', '64'));
    await act(async () => submit().click());
    expect(create).not.toHaveBeenCalled();
    await typeInto('factory-add-bot-name', 'C:\\Users\\dev');
    expect(blocked()).toBe(en['settings.factory.addBotBadName'].replace('{max}', '64'));
    await typeInto('factory-add-bot-name', "O'Brien-2, 리뷰 봇");
    expect(blocked()).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it('shows main\'s refusal and keeps the form', async () => {
    const { botPort, settingsPort, pickFolder } = setup({ ok: false, code: 'not_a_repo', message: '/src/app is not a git checkout.' });
    await render(createElement(FactoryTab, { settingsPort, botPort, pickFolder }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-open"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    await typeInto('factory-add-bot-name', 'Dev');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(container.querySelector('[data-testid="factory-add-bot-error"]')?.textContent).toBe('/src/app is not a git checkout.');
    expect(container.querySelector('[data-testid="factory-add-bot"]')).not.toBeNull();
  });

  it('without a create port there is no Add bot', async () => {
    const { settingsPort } = setup({ ok: true, bot: row('bot-00000001').bot });
    const botPort: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    expect(container.querySelector('[data-testid="factory-add-bot-open"]')).toBeNull();
  });
});

describe('Add bot: the repository comes from the workspace', () => {
  const APP = { repoKey: 'github.com/acme/app', repoPath: '/home/me/code/app' };
  const q = <E extends Element = HTMLElement>(id: string) => container.querySelector<E & HTMLElement>(`[data-testid="${id}"]`);

  function formPort(rows: FactoryBotRow[], suggest?: (ws: string) => Promise<FactoryBotRepoSuggestion>) {
    const create = vi.fn(async (_req: FactoryBotCreateRequest): Promise<FactoryBotCreateResult> => ({ ok: true, bot: row('bot-00000009').bot }));
    const suggestRepo = suggest ? vi.fn(suggest) : undefined;
    const port: FactoryBotPort = {
      available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }), create,
      ...(suggestRepo ? { suggestRepo } : {}),
    };
    return { port, create, suggestRepo };
  }

  async function renderForm(port: FactoryBotPort, rows: FactoryBotRow[], pickFolder = vi.fn(async (): Promise<string | null> => '/src/picked')) {
    const workspaces = [{ id: WS, name: 'App' }, { id: 'ws-b', name: 'Other' }];
    await render(createElement(AddBotForm, { port, t, rows, workspaces, defaultWorkspaceId: WS, pickFolder, onDone: () => undefined }));
    return pickFolder;
  }

  it('inherited: a workspace whose bot has a repo shows it read-only, with no picker, and sends no folder', async () => {
    const rows = [row('bot-00000001', { role: 'lead', repo: APP })];
    const { port, create } = formPort(rows, async () => ({ ok: true, repoKey: APP.repoKey, root: APP.repoPath, displayRoot: '~/code/app', inherited: true }));
    await renderForm(port, rows);
    await typeInto('factory-add-bot-name', 'Two');
    expect(q('factory-add-bot-repo')!.textContent).toBe('acme/app·~/code/app');
    expect(q('factory-add-bot-folder')).toBeNull();
    expect(container.textContent).toContain('settings.factory.addBotRepoInherited');
    const submit = q<HTMLButtonElement>('factory-add-bot-submit')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: 'Two' });
  });

  it('inherited from the listed bots even before (or without) main\'s suggestion', async () => {
    const rows = [row('bot-00000001', { role: 'lead', repo: APP })];
    const { port, create } = formPort(rows);
    await renderForm(port, rows);
    await typeInto('factory-add-bot-name', 'Two');
    expect(q('factory-add-bot-repo')!.textContent).toBe('acme/app·/home/me/code/app');
    expect(q('factory-add-bot-folder')).toBeNull();
    await act(async () => q<HTMLButtonElement>('factory-add-bot-submit')!.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: 'Two' });
  });

  it('suggested: main\'s repo for the workspace is pre-filled; Add sends its root, Change… opens the picker', async () => {
    const { port, create, suggestRepo } = formPort([], async () => ({ ok: true, repoKey: APP.repoKey, root: APP.repoPath, displayRoot: '~/code/app', inherited: false }));
    const pickFolder = await renderForm(port, []);
    await typeInto('factory-add-bot-name', 'Dev');
    expect(suggestRepo).toHaveBeenCalledWith(WS);
    expect(q('factory-add-bot-repo')!.textContent).toBe('acme/app·~/code/app');
    const change = q<HTMLButtonElement>('factory-add-bot-folder')!;
    expect(change.textContent).toBe('settings.factory.addBotChangeFolder');
    const submit = q<HTMLButtonElement>('factory-add-bot-submit')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(create).toHaveBeenLastCalledWith({ workspaceId: WS, name: 'Dev', repoFolder: APP.repoPath });
    await act(async () => change.click());
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(q('factory-add-bot-path')!.textContent).toBe('/src/picked');
    expect(q('factory-add-bot-repo')).toBeNull();
    await act(async () => submit.click());
    expect(create).toHaveBeenLastCalledWith({ workspaceId: WS, name: 'Dev', repoFolder: '/src/picked' });
  });

  it('none: with no suggestion the bot may go without a repository, or take a picked folder', async () => {
    const { port, create } = formPort([], async () => ({ ok: false, code: 'not_a_repo' }));
    await renderForm(port, []);
    await typeInto('factory-add-bot-name', 'Dev');
    expect(q('factory-add-bot-repo')).toBeNull();
    const choose = q<HTMLButtonElement>('factory-add-bot-folder')!;
    expect(choose.textContent).toBe('settings.factory.addBotChooseFolder');
    const submit = q<HTMLButtonElement>('factory-add-bot-submit')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(create).toHaveBeenLastCalledWith({ workspaceId: WS, name: 'Dev' });
    await act(async () => choose.click());
    await act(async () => submit.click());
    expect(create).toHaveBeenLastCalledWith({ workspaceId: WS, name: 'Dev', repoFolder: '/src/picked' });
  });

  it('another workspace asks again and drops the folder picked for the first', async () => {
    const { port, suggestRepo } = formPort([], async (ws) => (ws === WS
      ? { ok: false, code: 'no_folder' }
      : { ok: true, repoKey: 'github.com/acme/api', root: '/r/api', displayRoot: '/r/api', inherited: false }));
    await renderForm(port, []);
    await act(async () => q<HTMLButtonElement>('factory-add-bot-folder')!.click());
    expect(q('factory-add-bot-path')!.textContent).toBe('/src/picked');
    const ws = q<HTMLSelectElement>('factory-add-bot-workspace')!;
    await act(async () => {
      ws.value = 'ws-b';
      ws.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(suggestRepo).toHaveBeenLastCalledWith('ws-b');
    expect(q('factory-add-bot-path')).toBeNull();
    expect(q('factory-add-bot-repo')!.textContent).toBe('acme/api·/r/api');
  });

  it('asks again when the workspace\'s folder changes', async () => {
    useStore.setState({ workspaces: [{ id: WS, name: 'App', metadata: { cwd: '/a' } }] as never, activeWorkspaceId: WS });
    const { port, suggestRepo } = formPort([], async () => ({ ok: false, code: 'not_a_repo' }));
    await renderForm(port, []);
    expect(suggestRepo).toHaveBeenCalledTimes(1);
    await act(async () => useStore.setState({ workspaces: [{ id: WS, name: 'App', metadata: { cwd: '/b' } }] as never }));
    expect(suggestRepo).toHaveBeenCalledTimes(2);
    expect(suggestRepo).toHaveBeenLastCalledWith(WS);
  });

  it('the view: the workspace\'s own repo wins over a suggestion and a picked folder', () => {
    const own = [row('bot-00000001', { repo: APP })];
    const sug: FactoryBotRepoSuggestion = { ok: true, repoKey: 'github.com/acme/api', root: '/r/api', displayRoot: '/r/api', inherited: false };
    expect(addBotRepoView(own, WS, sug, '/x')).toEqual({ kind: 'inherited', repoKey: APP.repoKey, root: APP.repoPath, displayRoot: APP.repoPath });
    expect(addBotRepoView(own, 'ws-b', sug, null)).toMatchObject({ kind: 'suggested', root: '/r/api' });
    expect(addBotRepoView([], WS, sug, '/x')).toEqual({ kind: 'picked', folder: '/x' });
    expect(addBotRepoView([], WS, { ok: false, code: 'no_remote' }, null)).toEqual({ kind: 'none' });
    expect(addBotRepoView([], WS, { ...sug, inherited: true }, '/x')).toMatchObject({ kind: 'inherited', root: '/r/api' });
    expect(repoKeyLabel('github.com/acme/app')).toBe('acme/app');
    expect(repoKeyLabel('ghe.example.com/acme/app')).toBe('ghe.example.com/acme/app');
  });

  it('the profile editor shows a bot\'s repository read-only', async () => {
    const rows = [row('bot-00000001', { role: 'lead', repo: APP })];
    const update = vi.fn(async () => ({ ok: true }));
    const botPort: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }), update };
    const settingsPort = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => null) };
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    await act(async () => q<HTMLButtonElement>('factory-bot-row')!.click());
    const editor = q('factory-bot-editor')!;
    expect(editor.querySelector('[data-testid="factory-bot-repo"]')!.textContent).toBe('acme/app·/home/me/code/app');
    expect(editor.querySelector('[data-testid="factory-add-bot-folder"]')).toBeNull();
    expect(editor.querySelector('input[value="/home/me/code/app"]')).toBeNull();
  });

  it('the profile editor edits the job and the hourly cap (empty: none) and sends only what changed', async () => {
    const rows = [row('bot-00000001', { role: 'lead', job: 'Old job.', budget: { ...DEFAULT_BOT_BUDGETS.lead, maxTurnsPerHour: 6 } })];
    const update = vi.fn(async () => ({ ok: true }));
    const botPort: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }), update };
    const settingsPort = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => null) };
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    await act(async () => q<HTMLButtonElement>('factory-bot-row')!.click());
    expect(q<HTMLTextAreaElement>('factory-bot-job')!.value).toBe('Old job.');
    await typeInto('factory-bot-job', 'New job.');
    const hour = container.querySelector<HTMLInputElement>('[data-testid="factory-bot-editor"] input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hour, '');
      hour.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-editor"] button')].find((b) => b.textContent === en['settings.factory.save'])!;
    await act(async () => save.click());
    expect(update).toHaveBeenCalledWith('bot-00000001', expect.objectContaining({ job: 'New job.', budget: expect.objectContaining({ maxTurnsPerHour: null }) }));
  });
});

describe('BotChips secondary word', () => {
  it('lets the workspace give way before the name', async () => {
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(BotChips, { rows: [row('bot-00000001', { name: 'Moa' })], t, port, secondaryOf: () => 'A very long workspace name' }));
    const chip = container.querySelector('[data-testid="room-bot-chip"]')!;
    const name = chip.querySelector<HTMLElement>('[data-bot-name]')!;
    const secondary = chip.querySelector<HTMLElement>('[data-bot-secondary]')!;
    expect(name.textContent).toBe('Moa');
    expect(secondary.textContent).toBe('A very long workspace name');
    expect(secondary.className).toContain('truncate');
    expect(Number(secondary.style.flexShrink)).toBeGreaterThan(Number(getComputedStyle(name).flexShrink || 1));
    expect(chip.getAttribute('aria-label')).toContain('Moa, A very long workspace name');
  });
});

describe('Add team', () => {
  const q = <E extends Element = HTMLElement>(id: string) => container.querySelector<E & HTMLElement>(`[data-testid="${id}"]`);
  function teamPort(rows: FactoryBotRow[]) {
    const lead = row('bot-0000000a', { template: 'coordinator', role: 'moa', name: 'botsPage.teamName.coordinator' }).bot;
    const createTeam = vi.fn(async (_req: FactoryBotCreateTeamRequest): Promise<FactoryBotCreateTeamResult> => ({ ok: true, bots: [lead] }));
    const port: FactoryBotPort = {
      available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }),
      create: async () => ({ ok: false, code: 'invalid_argument', message: 'x' }), createTeam,
    };
    return { port, createTeam, lead };
  }

  it('adds the five named bots to the chosen workspace with its repository, and opens the lead', async () => {
    const { port, createTeam, lead } = teamPort([]);
    const onDone = vi.fn();
    await render(createElement(AddBotForm, { port, t, rows: [], workspaces: [{ id: WS, name: 'App' }], defaultWorkspaceId: WS, pickFolder: async () => '/src/app', onDone }));
    await act(async () => q<HTMLButtonElement>('factory-add-bot-folder')!.click());
    const button = q<HTMLButtonElement>('factory-add-team')!;
    expect(button.textContent).toBe('settings.factory.addTeam');
    // No name needed: Add team works while Add waits for one.
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(createTeam).toHaveBeenCalledWith({
      workspaceId: WS,
      repoFolder: '/src/app',
      names: {
        coordinator: 'botsPage.teamName.coordinator', researcher: 'botsPage.teamName.researcher', developer: 'botsPage.teamName.developer',
        issue: 'botsPage.teamName.issue', reviewer: 'botsPage.teamName.reviewer',
      },
    });
    // The lead opens; the whole team goes along (the page offers a group chat with it).
    expect(onDone).toHaveBeenCalledWith(lead, [lead]);
  });

  it('is not offered in a workspace that already has a coordinator; with the bots off it asks first', async () => {
    const withLead = [row('bot-00000001', { template: 'coordinator', role: 'moa' })];
    const { port } = teamPort(withLead);
    await render(createElement(AddBotForm, { port, t, rows: withLead, workspaces: [{ id: WS, name: 'App' }], defaultWorkspaceId: WS, onDone: () => undefined }));
    expect(q('factory-add-team')).toBeNull();
    const off = teamPort([]);
    const turnOn = vi.fn(async () => 'on' as const);
    await render(createElement(AddBotForm, { port: off.port, t, rows: [], workspaces: [{ id: WS, name: 'App' }], defaultWorkspaceId: WS, onDone: () => undefined, botsOff: true, turnOn }));
    await act(async () => q<HTMLButtonElement>('factory-add-team')!.click());
    expect(off.createTeam).not.toHaveBeenCalled();
    expect(container.textContent).toContain('settings.factory.addTeamTurnsOn');
  });

  it('a room with a coordinator says its message goes to the lead', async () => {
    const team = [row('bot-00000002', { createdAt: 1 }), row('bot-00000003', { template: 'coordinator', role: 'moa', name: 'Lead', createdAt: 2 })];
    expect(roomLead(team)?.bot.id).toBe('bot-00000003');
    expect(roomLead([team[0]])).toBeNull();
    await render(createElement(MentionChips, { candidates: team, bots: team, picked: [], onToggle: () => undefined, t, testId: 'chips' }));
    expect(q('chips-to-room')!.textContent).toBe('room.composer.toLead(name=Lead)');
  });
});

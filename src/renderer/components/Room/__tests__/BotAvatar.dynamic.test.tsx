// @vitest-environment jsdom
//
// Bots look like members: BotAvatar draws the owner's picture or the bot's
// Mochi character — the one of its identity colour slot, moving (idle, or
// hopping while it works); Settings › Factory's Add bot takes
// a name and a picture (a preview from main), the profile editor changes or
// removes the picture on Save, and the bot list and chips show the avatar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { BOT_NAME_MAX, DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import type { FactoryBotAvatarPickResult, FactoryBotCreateRequest } from '../../../../shared/botCreate';
import BotAvatar, { BOT_IDENTITY_HUES, botCharacter, botIdentityColor, botInitials, IDENTITY_SPREAD, identityHueIndexes, noteBotIdentities } from '../BotAvatar';
import { MOCHI_CHARACTERS } from '../mochiCharacters';
import { BotChips } from '../BotChips';
import { RoomCard } from '../RoomCard';
import type { RoomCard as RoomCardData } from '../../../../shared/room';
import { AddBotForm, FactoryTab, avatarPickError } from '../../Settings/FactoryTab';
import { BotSettingsPage } from '../../Bots/BotSettingsPage';
import type { FactoryBotPort, FactoryBotRow } from '../factoryPorts';

const WS = 'ws-a';
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;
const roleT = (key: string, vars?: Record<string, string | number>) =>
  (key.startsWith('room.role.') ? key.slice('room.role.'.length).replace(/^./, (c) => c.toUpperCase()) : t(key, vars));

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

function row(id: string, over: Partial<BotProfile> = {}): FactoryBotRow {
  return {
    bot: {
      version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
      budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, ...over,
    },
    status: null,
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('botInitials', () => {
  it('Latin: two words give two letters, one word one', () => {
    expect(botInitials('Ada Lovelace', 'Lead')).toBe('AL');
    expect(botInitials('verifier', 'Verifier')).toBe('V');
    expect(botInitials('release-bot', 'Lead')).toBe('RB');
    expect(botInitials('  grace   hopper  team ', 'Lead')).toBe('GH');
  });

  it('Korean and CJK: the first syllable or character', () => {
    expect(botInitials('검증봇', 'Verifier')).toBe('검');
    expect(botInitials('김 철수', 'Lead')).toBe('김');
    expect(botInitials('测试机器人', 'Lead')).toBe('测');
    expect(botInitials('テスト', 'Lead')).toBe('テ');
  });

  it('a blank name falls back to the role label', () => {
    expect(botInitials('', 'Verifier')).toBe('V');
    expect(botInitials('   ', 'Maintainer')).toBe('M');
    expect(botInitials('', '')).toBe('?');
  });
});

/** A hex colour's hue in degrees and its saturation (0–1). */
function hueOf(hex: string): { h: number; s: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(max + min - 1)) };
}

describe('bot identity', () => {
  it('a bot keeps its colour and character; bots differ; no identity colour is a state colour', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `bot-${i.toString(16).padStart(8, '0')}`);
    for (const id of ids) {
      expect(botIdentityColor(id)).toBe(botIdentityColor(id));
      expect(botCharacter(id)).toBe(botCharacter(id));
    }
    expect(new Set(ids.map(botIdentityColor)).size).toBeGreaterThan(4);
    expect(new Set(ids.map((id) => botCharacter(id).name)).size).toBeGreaterThan(4);
    // Red, orange, yellow and green (0–170°) mean error, needs you,
    // caution and done: every saturated identity hue sits outside them.
    for (const hex of BOT_IDENTITY_HUES) {
      const { h, s } = hueOf(hex);
      if (s > 0.25) expect(h >= 185 && h <= 330).toBe(true);
    }
    // Mixed toward the look's text colour, so it reads on light and dark looks.
    expect(botIdentityColor(ids[0])).toContain('var(--text-main)');
  });

  it('a room\'s bots take colours in the spread order: five team bots read apart, never palette neighbours', () => {
    const team = ['lead', 'research', 'dev', 'issues', 'review'].map((n, i) => ({ id: `bot-team-${n}`, createdAt: i, workspaceId: 'ws-team' }));
    const at = identityHueIndexes(team);
    const picked = team.map((b) => at.get(b.id)!);
    expect(picked).toEqual(IDENTITY_SPREAD.slice(0, 5));
    expect(new Set(picked).size).toBe(5);
    // Every two saturated colours of the five are at least 30° of hue apart.
    const hues = picked.map((i) => hueOf(BOT_IDENTITY_HUES[i])).filter((c) => c.s > 0.25).map((c) => c.h);
    for (const a of hues) for (const b of hues) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(30);
    expect(IDENTITY_SPREAD.slice().sort()).toEqual(BOT_IDENTITY_HUES.map((_, i) => i));
  });

  it('colours are per room, a bot keeps its own while it exists, and a removed bot frees its colour', () => {
    const roomA = Array.from({ length: 8 }, (_, i) => ({ id: `bot-room-a-${i}`, createdAt: i, workspaceId: 'ws-a' }));
    const roomB = [{ id: 'bot-room-b-0', createdAt: 0, workspaceId: 'ws-b' }];
    // Eight bots of a room, eight colours; another room starts over.
    expect(new Set(identityHueIndexes(roomA).values()).size).toBe(8);
    noteBotIdentities([...roomA, ...roomB], true);
    expect(botIdentityColor(roomB[0].id)).toBe(botIdentityColor(roomA[0].id));
    const before = roomA.map((b) => botIdentityColor(b.id));
    // A bot added to room A after one left takes the freed colour; the others keep theirs.
    const added = { id: 'bot-room-a-new', createdAt: 99, workspaceId: 'ws-a' };
    noteBotIdentities([...roomA.slice(1), added, ...roomB], true);
    expect(roomA.slice(1).map((b) => botIdentityColor(b.id))).toEqual(before.slice(1));
    expect(botIdentityColor(added.id)).toBe(before[0]);
  });

  it('a bot with a stored slot (BotProfile.hue) keeps it, whatever the others and their order; one without falls back to the spread', () => {
    const kept = [
      { id: 'bot-kept-b', createdAt: 2, workspaceId: 'ws-kept', hue: IDENTITY_SPREAD[1] },
      { id: 'bot-kept-c', createdAt: 3, workspaceId: 'ws-kept', hue: IDENTITY_SPREAD[2] },
    ];
    noteBotIdentities(kept, true);
    expect(botCharacter('bot-kept-b')).toBe(MOCHI_CHARACTERS[IDENTITY_SPREAD[1]]);
    expect(botCharacter('bot-kept-c')).toBe(MOCHI_CHARACTERS[IDENTITY_SPREAD[2]]);
    const legacy = { id: 'bot-kept-old', createdAt: 9, workspaceId: 'ws-kept' };
    noteBotIdentities([...kept, legacy], true);
    expect(botCharacter(legacy.id)).toBe(MOCHI_CHARACTERS[IDENTITY_SPREAD[0]]);
  });

  it('a bot\'s character is the one of its colour slot: each character wears its own designed colour', () => {
    expect(MOCHI_CHARACTERS.map((c) => c.body)).toEqual([...BOT_IDENTITY_HUES]);
    expect(new Set(MOCHI_CHARACTERS.map((c) => c.name)).size).toBe(BOT_IDENTITY_HUES.length);
    // A room's bots never share a character while there are eight or fewer.
    const room = Array.from({ length: 8 }, (_, i) => ({ id: `bot-char-${i}`, createdAt: i, workspaceId: 'ws-char' }));
    noteBotIdentities(room);
    const at = identityHueIndexes(room);
    for (const b of room) {
      expect(botCharacter(b.id)).toBe(MOCHI_CHARACTERS[at.get(b.id)!]);
      expect(botIdentityColor(b.id)).toContain(botCharacter(b.id).body);
    }
    expect(new Set(room.map((b) => botCharacter(b.id).name)).size).toBe(8);
  });
});

describe('BotAvatar', () => {
  it('draws the picture when there is one', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000001', name: 'Ada', role: 'lead', avatar: PICTURE }, size: 20, t: roleT }));
    const el = container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el.dataset.botAvatar).toBe('image');
    expect(el.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
    expect(el.style.width).toBe('20px');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('without a picture draws the bot\'s character, and names itself when asked', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000002', name: ' ', role: 'verifier' }, size: 16, t: roleT, alt: 'Verifier' }));
    const el = container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el.dataset.botAvatar).toBe('face');
    expect(el.dataset.avatarCharacter).toBe(botCharacter('bot-00000002').name);
    expect(el.querySelector(`stop[stop-color="${botCharacter('bot-00000002').body}"]`)).not.toBeNull();
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Verifier');
  });

  it('two of the same character on a page never share a gradient id, and each resolves inside its own svg', async () => {
    const bot = { id: 'bot-00000004', name: 'Ada', role: 'lead' as const };
    await render(createElement('div', null, createElement(BotAvatar, { bot, size: 32 }), createElement(BotAvatar, { bot, size: 32 })));
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs).toHaveLength(2);
    const ids = [...container.querySelectorAll('[id]')].map((n) => n.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of svgs) {
      const refs = [...svg.querySelectorAll('[fill]')].map((n) => n.getAttribute('fill')!).filter((f) => f.startsWith('url(#')).map((f) => f.slice(5, -1));
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(svg.querySelector(`[id="${ref}"]`)).not.toBeNull();
    }
  });

  it('working hops: the prop toggles the class; small avatars are marked to only blink', async () => {
    const bot = { id: 'bot-00000005', name: 'Ada', role: 'lead' as const };
    await render(createElement(BotAvatar, { bot, size: 32 }));
    const el = () => container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el().classList.contains('wmux-mochi')).toBe(true);
    expect(el().classList.contains('is-working')).toBe(false);
    expect(el().hasAttribute('data-avatar-small')).toBe(false);
    await render(createElement(BotAvatar, { bot, size: 32, working: true }));
    expect(el().classList.contains('is-working')).toBe(true);
    await render(createElement(BotAvatar, { bot, size: 20, working: true }));
    expect(el().hasAttribute('data-avatar-small')).toBe(true);
  });

  it('an offscreen avatar is paused, and only animated ones are watched', async () => {
    const observed: Element[] = [];
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
    vi.resetModules();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof report) { report = cb; }
      observe(el: Element) { observed.push(el); }
      unobserve(el: Element) { observed.splice(observed.indexOf(el), 1); }
      disconnect() { observed.length = 0; }
    });
    const { default: Fresh } = await import('../BotAvatar');
    await render(createElement('div', null,
      createElement(Fresh, { bot: { id: 'bot-00000006', name: 'Ada', role: 'lead' }, size: 32 }),
      createElement(Fresh, { bot: { id: 'bot-00000007', name: 'Ada', role: 'lead', avatar: PICTURE }, size: 32 }),
      createElement(Fresh, { bot: { id: 'bot-00000008', name: 'Ada', role: 'lead' }, size: 32, placeholder: true })));
    expect(observed).toHaveLength(1);
    const face = container.querySelector('[data-bot-avatar="face"]')!;
    expect(observed[0]).toBe(face);
    act(() => report!([{ target: face, isIntersecting: false }]));
    expect(face.hasAttribute('data-avatar-offscreen')).toBe(true);
    act(() => report!([{ target: face, isIntersecting: true }]));
    expect(face.hasAttribute('data-avatar-offscreen')).toBe(false);
  });

  it('the motion stylesheet stops everything under reduced motion and pauses offscreen avatars', () => {
    const css = readFileSync(join(__dirname, '..', 'botAvatar.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.length).toBeLessThan(css.length);
    for (const cls of ['.wmux-mochi-body', '.wmux-mochi-eye', '.wmux-mochi-sig']) expect(reduced).toContain(cls);
    expect(reduced).toContain('animation: none !important');
    expect(css).toMatch(/\[data-avatar-offscreen\][^{]*\{\s*animation-play-state: paused/);
    // A hidden window stops (not pauses) every animated part: Blink keeps a removed
    // element's animations, and its detached tree, until the next drawn frame.
    for (const cls of ['.wmux-mochi-body', '.wmux-mochi-eye', '.wmux-mochi-sig']) expect(css).toContain(`:root[data-document-hidden] .wmux-mochi ${cls}`);
    expect(css).toMatch(/:root\[data-document-hidden\] \.wmux-mochi \.wmux-mochi-sig\s*\{\s*animation: none !important/);
    // Every character's animated parts carry the shared role classes the rules key on.
    for (let i = 1; i <= 8; i++) expect(css).toContain(`.wmux-mochi.is-working .wmux-mo${i}-root`);
    // Every animation the rules name has its keyframes (a missing one leaves a character still).
    const defined = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]));
    const used = [...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]).filter((n) => n !== 'none');
    expect(used.length).toBeGreaterThan(16);
    expect(used.filter((n) => !defined.has(n))).toEqual([]);
  });

  it('the add form\'s placeholder is a neutral, still mochi', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000009', name: 'Ada', role: 'lead' }, size: 32, placeholder: true }));
    const el = container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el.dataset.botAvatar).toBe('placeholder');
    expect(el.hasAttribute('data-avatar-character')).toBe(false);
    expect(el.classList.contains('wmux-mochi')).toBe(false);
    expect(el.querySelector('[id], [class]')).toBeNull();
    expect(el.querySelector('g')?.getAttribute('style')).toContain('var(--text-muted)');
  });

  it('never uses something other than a PNG data URL as an image', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000003', name: 'Ada', role: 'lead', avatar: 'https://example.com/a.png' }, size: 16, t: roleT }));
    expect(container.querySelector('[data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('face');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Add bot: name and picture', () => {
  function port(pick: FactoryBotAvatarPickResult) {
    const create = vi.fn(async (_req: FactoryBotCreateRequest) => ({ ok: true as const, bot: row('bot-00000009').bot }));
    const pickAvatar = vi.fn(async () => pick);
    const p: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create, pickAvatar };
    return { p, create, pickAvatar };
  }

  beforeEach(() => {
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
  });

  it('sends the trimmed name and the picked picture; the preview shows it until removed', async () => {
    const { p, create, pickAvatar } = port({ ok: true, avatar: PICTURE });
    const onDone = vi.fn();
    await render(createElement(AddBotForm, { port: p, rows: [], t: roleT, onDone, pickFolder: async () => '/src/app' }));
    const name = container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    expect(name.placeholder).toBe('settings.factory.addBotNamePlaceholder');
    expect(name.maxLength).toBe(BOT_NAME_MAX);
    // No picture yet: a neutral face — the bot's colour and shape come from
    // the id main gives it, which the form cannot know.
    expect(container.querySelector('[data-testid="factory-picture-preview"] [data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('placeholder');
    await act(async () => typeInto(name, '  Ada Lovelace '));
    expect(container.querySelector('[data-testid="factory-picture-remove"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(pickAvatar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')?.getAttribute('src')).toBe(PICTURE);
    // Remove, then choose again.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-remove"]')!.click());
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, repoFolder: '/src/app', name: 'Ada Lovelace', avatar: PICTURE });
    expect(onDone).toHaveBeenCalled();
  });

  it('a blank name cannot be added; a cancelled pick sends no picture', async () => {
    const { p, create } = port({ ok: false, code: 'cancelled' });
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined, pickFolder: async () => '/src/app' }));
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, '   '));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(container.querySelector('[data-testid="factory-add-bot-error"]')).toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'Dev'));
    await act(async () => submit.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: 'Dev' });
  });

  it('a refused pick says why and keeps the form; a name with a control character disables Add', async () => {
    const { p } = port({ ok: false, code: 'too_large' });
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined, pickFolder: async () => '/src/app' }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(container.querySelector('[data-testid="factory-add-bot-error"]')?.textContent).toBe('settings.factory.pictureTooLarge');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'Dev'));
    expect(submit.disabled).toBe(false);
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'a\u0007b'));
    expect(submit.disabled).toBe(true);
    expect(avatarPickError({ ok: false, code: 'unreadable' }, t)).toBe('settings.factory.pictureUnreadable');
    expect(avatarPickError({ ok: false, code: 'cancelled' }, t)).toBeNull();
  });

  it('without a pick port there is no picture row', async () => {
    const p: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create: vi.fn() };
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined }));
    expect(container.querySelector('[data-testid="factory-picture-choose"]')).toBeNull();
    expect(container.querySelector('[data-testid="factory-add-bot-name"]')).not.toBeNull();
  });
});

describe('Settings bot list, a bot\'s settings page and chips', () => {
  const view = {
    version: 1 as const, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
    verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
  };

  it('each Settings row shows its avatar', async () => {
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
    const rows = [row('bot-00000001', { name: 'Ada', avatar: PICTURE }), row('bot-00000002', { name: '검증봇', role: 'verifier' })];
    const botPort: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async () => view) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const rowEls = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-row"]')];
    expect(rowEls[0].querySelector('[data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('image');
    expect(rowEls[1].querySelector('[data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('face');
  });

  it('the settings page changes the picture on Save and removes it; a refused profile saves no picture', async () => {
    const bot = row('bot-00000001', { name: 'Ada', avatar: PICTURE });
    const setAvatar = vi.fn(async (_id: string, avatar: string | null) => ({ ok: true as const, bot: { ...bot.bot, ...(avatar ? { avatar } : {}) } }));
    const update = vi.fn(async () => ({ ok: true }));
    const pickAvatar = vi.fn(async () => ({ ok: true as const, avatar: `${PICTURE}AA` }));
    const page = (r: FactoryBotRow) => createElement(BotSettingsPage, {
      row: r, workers: [], workspaceName: 'App', t, port: { update, setAvatar, pickAvatar }, stopPort: {},
      onBack: () => undefined, onDirtyChange: () => undefined, leaveAsk: null,
    });
    await render(page(bot));
    const save = () => container.querySelector<HTMLButtonElement>('[data-testid="bot-settings-save"]')!;
    // Change: nothing is saved until Save.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(setAvatar).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')?.getAttribute('src')).toBe(`${PICTURE}AA`);
    await act(async () => save().click());
    expect(setAvatar).toHaveBeenCalledWith('bot-00000001', `${PICTURE}AA`);
    // A picture alone sends no profile patch.
    expect(update).not.toHaveBeenCalled();

    // Remove.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-remove"]')!.click());
    await act(async () => save().click());
    expect(setAvatar).toHaveBeenLastCalledWith('bot-00000001', null);

    // A refused profile saves no picture and keeps the changes.
    update.mockResolvedValueOnce({ ok: false, message: 'budget is malformed or over its caps' } as never);
    setAvatar.mockClear();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    const name = container.querySelector<HTMLInputElement>('[data-testid="bot-settings-name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Ada 2');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => save().click());
    expect(update).toHaveBeenCalledWith('bot-00000001', { name: 'Ada 2' });
    expect(setAvatar).not.toHaveBeenCalled();
    expect(container.querySelector('[data-bot-settings-foot]')?.textContent).toContain('budget is malformed');
  });

  it('a chip leads with the bot\'s avatar', async () => {
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(BotChips, { rows: [row('bot-00000001', { name: 'Ada Lovelace' }), row('bot-00000002', { name: 'Moa', avatar: PICTURE })], t, port }));
    const chips = [...container.querySelectorAll('[data-testid="room-bot-chip"]')];
    expect(chips[0].firstElementChild?.getAttribute('data-bot-avatar')).toBe('face');
    expect(chips[1].querySelector('img')?.getAttribute('src')).toBe(PICTURE);
  });
});

describe('RoomCard author', () => {
  const card = (actor: RoomCardData['actor']): RoomCardData => ({
    version: 1, id: 'c-1', seq: 1, workspaceId: WS, threadId: 'general', kind: 'status', at: 1, actor, title: 'Hello',
  });

  it('a bot author gets its 16px avatar; the human and the system none', async () => {
    const bots = [row('bot-00000001', { name: 'Ada', avatar: PICTURE })];
    await render(createElement(RoomCard, { card: card({ kind: 'bot', workspaceId: WS, botId: 'bot-00000001' }), workspaceId: WS, t, bots }));
    const avatar = container.querySelector<HTMLElement>('[data-testid="room-card"] [data-bot-avatar]')!;
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
    expect(avatar.style.width).toBe('16px');
    await render(createElement(RoomCard, { card: card({ kind: 'human' }), workspaceId: WS, t, bots }));
    expect(container.querySelector('[data-testid="room-card"] [data-bot-avatar]')).toBeNull();
  });
});

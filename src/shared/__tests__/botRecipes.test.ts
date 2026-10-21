// @wmux-lane unit
// 'win32' here is only the platform value the pure checklist takes; nothing
// reads the OS.
// The recipe catalog's shape, and where each of a recipe's connections
// stands for one bot (the profile's checklist).
import { describe, expect, it } from 'vitest';
import type { Connector } from '../botConnector';
import { CONNECTOR_PRESETS } from '../botConnectorPresets';
import { BOT_RECIPES, BOT_RECIPE_ID_RE, botRecipe, recipeChecklist, recipeConnectorState, recipeNeedsOwnClient, type RecipeConnectorContext } from '../botRecipes';
import { CONNECTOR_SERVICES, serviceConnectorDraft } from '../connectorServices';

const BOT = 'bot-0000000a';
const notion = CONNECTOR_SERVICES.find((s) => s.id === 'notion')!;

function service(id: string, over: Partial<Connector> = {}): Connector {
  const s = CONNECTOR_SERVICES.find((x) => x.id === id)!;
  return { ...serviceConnectorDraft(s), id: 'con-0000000' + id.length, name: s.id, offFor: [], createdAt: 1, updatedAt: 1, ...over };
}

function ctx(library: Connector[] | null, signed: Record<string, boolean | undefined> = {}, platform = 'darwin'): RecipeConnectorContext {
  return { library, botId: BOT, platform, signedIn: (id) => signed[id] };
}

const state = (id: string, c: RecipeConnectorContext) => recipeConnectorState(id, c).state;

describe('BOT_RECIPES', () => {
  it('names only catalog services or the GitHub preset, never mixes the preset with a sign-in service, and never uses the researcher template', () => {
    const ids = new Set(BOT_RECIPES.map((r) => r.id));
    expect(ids.size).toBe(BOT_RECIPES.length);
    for (const r of BOT_RECIPES) {
      expect(r.id).toMatch(BOT_RECIPE_ID_RE);
      expect(r.connectors.length).toBeGreaterThan(0);
      for (const id of r.connectors) {
        expect(CONNECTOR_SERVICES.some((s) => s.id === id) || CONNECTOR_PRESETS.some((p) => p.id === id)).toBe(true);
      }
      const services = r.connectors.filter((id) => CONNECTOR_SERVICES.some((s) => s.id === id));
      expect(services.length === 0 || services.length === r.connectors.length).toBe(true);
      expect(r.template).not.toBe('researcher');
      expect(botRecipe(r.id)).toBe(r);
      // A signed-in task runs once per conversation for now: no schedules.
      expect(r).not.toHaveProperty('suggestedSchedule');
    }
  });

  it('lists the one-click sign-in recipes first and those needing the owner\'s own OAuth client last', () => {
    const own = BOT_RECIPES.map(recipeNeedsOwnClient);
    expect(own.indexOf(true)).toBeGreaterThan(0);
    expect(own.slice(own.indexOf(true)).every(Boolean)).toBe(true);
    const firstOneClick = BOT_RECIPES.findIndex((r) => r.connectors.every((id) => CONNECTOR_SERVICES.find((s) => s.id === id)?.setup === 'oauth'));
    expect(firstOneClick).toBe(0);
  });
});

describe('recipeConnectorState', () => {
  it('walks a sign-in service through the owner\'s steps: sign in, give it to the bot, pick its tools', () => {
    expect(recipeConnectorState('notion', ctx([]))).toEqual({ state: 'signIn' });
    // Connect in Plugins › Connectors saves it on, for no bot, with no tools.
    const fresh = service('notion', { enabled: true });
    expect(state('notion', ctx([fresh]))).toBe('checking');
    expect(state('notion', ctx([fresh], { [fresh.id]: false }))).toBe('signIn');
    expect(state('notion', ctx([fresh], { [fresh.id]: true }))).toBe('notForBot');
    const given = { ...fresh, scope: { kind: 'bots' as const, botIds: [BOT] } };
    expect(state('notion', ctx([given], { [given.id]: true }))).toBe('toolsNotPicked');
    // The gateway serves only the tools the owner listed: "all" is not picked.
    expect(state('notion', ctx([{ ...given, tools: { mode: 'all', blocked: [] } }], { [given.id]: true }))).toBe('toolsNotPicked');
    const picked = { ...given, tools: { mode: 'listed' as const, allowed: ['notion-search', 'notion-fetch'] } };
    expect(recipeConnectorState('notion', ctx([picked], { [picked.id]: true }))).toEqual({ state: 'ready', via: 'signIn' });
    // Off, or switched off for this bot, is not given to it.
    expect(state('notion', ctx([{ ...picked, enabled: false }], { [picked.id]: true }))).toBe('notForBot');
    expect(state('notion', ctx([{ ...picked, scope: { kind: 'all' }, offFor: [BOT] }], { [picked.id]: true }))).toBe('notForBot');
  });

  it('is checking while the library is unread, and macOS and Linux only on Windows', () => {
    expect(state('notion', ctx(null))).toBe('checking');
    const picked = service('notion', { enabled: true, scope: { kind: 'all' }, tools: { mode: 'listed', allowed: ['notion-search'] } });
    expect(state('notion', ctx([picked], { [picked.id]: true }, 'win32'))).toBe('platform');
    expect(state('github', ctx(null, {}, 'win32'))).toBe('platform');
  });

  it('reads a service set up with a key by its key, never as a sign-in', () => {
    const keyed = service('notion', {
      enabled: true, scope: { kind: 'all' }, tools: { mode: 'all', blocked: [] },
      secrets: [{ secret: 'NOTION_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    });
    const signedIn = () => { throw new Error('a keyed connection has no sign-in to read'); };
    expect(recipeConnectorState('notion', { ...ctx([{ ...keyed, missingKeys: ['NOTION_MCP_TOKEN'] } as Connector]), signedIn })).toEqual({ state: 'signIn', via: 'key' });
    expect(recipeConnectorState('notion', { ...ctx([{ ...keyed, missingKeys: [] } as Connector]), signedIn })).toEqual({ state: 'ready', via: 'key' });
  });

  it('matches a service by its endpoint only, and takes the furthest of several connections', () => {
    const other = service('notion', { id: 'con-000000aa', remote: { url: 'https://example.com/mcp', headers: {} }, enabled: true, scope: { kind: 'all' } });
    expect(state('notion', ctx([other], { [other.id]: true }))).toBe('signIn');
    const a = service('notion', { id: 'con-000000ab', enabled: true });
    const b = service('notion', { id: 'con-000000ac', enabled: true, scope: { kind: 'all' }, tools: { mode: 'listed', allowed: ['notion-search'] } });
    expect(state('notion', ctx([a, b], { [a.id]: false, [b.id]: true }))).toBe('ready');
    expect(a.remote?.url).toBe(notion.url);
  });

  it('reads the GitHub preset\'s key instead of a sign-in, and takes its blocked-writes tool list as picked', () => {
    const preset = CONNECTOR_PRESETS.find((p) => p.id === 'github')!.draft;
    const gh = { ...preset, id: 'con-0000000f', offFor: [], createdAt: 1, updatedAt: 1 } as Connector;
    expect(recipeConnectorState('github', ctx([{ ...gh, missingKeys: ['GITHUB_MCP_TOKEN'] } as Connector]))).toEqual({ state: 'signIn', via: 'key' });
    expect(recipeConnectorState('github', ctx([{ ...gh, missingKeys: [] } as Connector]))).toEqual({ state: 'ready', via: 'key' });
    expect(state('github', ctx([{ ...gh, missingKeys: [], scope: { kind: 'bots', botIds: [] } } as Connector]))).toBe('notForBot');
  });

  it('lists each connection of a recipe in order, with its name', () => {
    const r = botRecipe('meetingPrep')!;
    expect(recipeChecklist(r, ctx([])).map((x) => [x.id, x.name, x.state])).toEqual([
      ['google-calendar', 'Google Calendar', 'signIn'],
      ['gmail', 'Gmail', 'signIn'],
    ]);
  });
});

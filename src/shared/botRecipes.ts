// ─── Bot recipes — data only, each a read-and-report job ───────────────────
//
// A recipe is a starting point for "Add bot": it prefills the job text and
// names the connections the job needs. The bot is made through the one
// create path (shared/botCreate.ts) and the recipe grants nothing: no
// connection is made, enabled, signed in or given to the bot, and no tool is
// picked. The owner does that in Plugins › Connectors, as for any
// connection. The bot keeps the recipe's id (BotProfile.recipe, display
// only), so its profile can list what each connection still needs.
//
// Every recipe only reads and reports, because a bot's worker gets a
// signed-in connection only through main's gateway (main/connectors/
// workerGateway.ts), and that path is read-only: the research preset, the
// owner's picked tools, each one marked read-only by the service, no other
// connection in the same task, no Windows. Anything a job would write (a
// reply, an event, a page) is drafted in the chat for the owner. GitHub is
// the one preset here (shared/botConnectorPresets.ts): a key, not a sign-in,
// with its write tools blocked. A recipe never mixes it with a sign-in
// service, since a task with a signed-in connection carries no other kind.
//
// No recipe offers a schedule yet: a signed-in task's result marks the bot's
// conversation as having taken in outside text, and the gateway then refuses
// the next signed-in task in it, so a routine would run once.

import type { BotTemplate } from './bot';
import type { Connector, ConnectorPresetId } from './botConnector';
import { connectorsForBot } from './botConnector';
import { CONNECTOR_SERVICES, isSignInService } from './connectorServices';

/** A connection a recipe needs: a CONNECTOR_SERVICES id, or a preset id. */
export type BotRecipeConnector = string;

export interface BotRecipe {
  id: string;
  /** i18n key of the recipe's name. */
  titleKey: string;
  /** i18n key of its one-line description. */
  hintKey: string;
  /** i18n key of what the job asks for; the full job adds the shared
   *  how-to-work lines (renderer Bots/BotRecipes.tsx recipeJob). */
  jobKey: string;
  /** The template the bot is made from. Never 'researcher': its tasks are
   *  always counted as started from outside text, which the gateway refuses. */
  template: BotTemplate;
  /** The connections it needs, in the order they are listed. */
  connectors: readonly BotRecipeConnector[];
}

function recipe(id: string, connectors: readonly BotRecipeConnector[]): BotRecipe {
  return {
    id,
    titleKey: `botRecipes.${id}.title`,
    hintKey: `botRecipes.${id}.hint`,
    jobKey: `botRecipes.${id}.job`,
    // Custom: no template default moves the bot's model or grants a power.
    template: 'custom',
    connectors,
  };
}

/** One-click sign-in services first, then the GitHub preset, then the
 *  services that need the owner's own OAuth client. */
export const BOT_RECIPES: readonly BotRecipe[] = [
  recipe('notionMeetingDigest', ['notion']),
  recipe('notionStalePages', ['notion']),
  recipe('figmaHandoff', ['figma']),
  recipe('canvaCopyCheck', ['canva']),
  recipe('linearStandup', ['linear']),
  recipe('atlassianSprint', ['atlassian']),
  recipe('asanaDueSoon', ['asana']),
  recipe('githubWeek', ['github']),
  recipe('gmailTriage', ['gmail']),
  recipe('meetingPrep', ['google-calendar', 'gmail']),
  recipe('freeSlots', ['google-calendar']),
  recipe('sheetReport', ['google-sheets']),
  recipe('driveStaleFiles', ['google-drive']),
  recipe('slackCatchUp', ['slack']),
  recipe('slackDecisions', ['slack']),
];

/** The shape of a recipe id as a profile stores it. An id of this shape
 *  that this build does not know is kept (a newer build wrote it) and
 *  simply not shown. */
export const BOT_RECIPE_ID_RE = /^[a-z][A-Za-z0-9]{0,39}$/;

/** The presets a recipe may name, with their display names. */
const PRESET_NAMES: Readonly<Partial<Record<ConnectorPresetId, string>>> = { github: 'GitHub' };

export function botRecipe(id: unknown): BotRecipe | undefined {
  return typeof id === 'string' ? BOT_RECIPES.find((r) => r.id === id) : undefined;
}

/** A connection's display name (the service's own, or the preset's), or
 *  undefined when the id is neither. */
export function recipeConnectorName(id: BotRecipeConnector): string | undefined {
  return CONNECTOR_SERVICES.find((s) => s.id === id)?.name ?? PRESET_NAMES[id as ConnectorPresetId];
}

/** Whether a catalog service is signed in with the owner's own OAuth client
 *  (Google, Slack) rather than in one click. */
export function recipeConnectorNeedsOwnClient(id: BotRecipeConnector): boolean {
  const service = CONNECTOR_SERVICES.find((s) => s.id === id);
  return !!service && service.setup !== 'oauth';
}

/** Whether any of a recipe's connections needs the owner's own OAuth client. */
export function recipeNeedsOwnClient(r: Pick<BotRecipe, 'connectors'>): boolean {
  return r.connectors.some(recipeConnectorNeedsOwnClient);
}

/** Whether a library connection is the one a recipe names: a service by its
 *  endpoint (as the service catalog finds an existing one), a preset by its
 *  preset id. */
export function connectorServes(id: BotRecipeConnector, c: Pick<Connector, 'transport' | 'remote' | 'preset'>): boolean {
  const service = CONNECTOR_SERVICES.find((s) => s.id === id);
  if (service) return c.transport === 'http' && c.remote?.url === service.url;
  return id in PRESET_NAMES && c.preset === id;
}


/** Where one of a recipe's connections stands for one bot, as its next step:
 *  platform    Windows: no connection reaches a bot's worker there yet.
 *  checking    the library or a sign-in is still being read.
 *  signIn      the library has none, or it is not signed in (a sign-in
 *              service) or its key is not stored (a keyed connection).
 *  notForBot   it is off, or not given to this bot.
 *  toolsNotPicked  no tools picked: a signed-in connection serves only the
 *              tools the owner listed, and a keyed one listing none has none.
 *  ready       nothing left here. Main still checks at the worker's start
 *              (each picked tool marked read-only by the service, the
 *              command sandbox), so this is "ready to try", not a promise. */
export type RecipeConnectorState = 'platform' | 'checking' | 'signIn' | 'notForBot' | 'toolsNotPicked' | 'ready';

/** How far along each state is: the best of a service's connections wins. */
const PROGRESS: Readonly<Record<RecipeConnectorState, number>> = {
  platform: -1, signIn: 0, checking: 1, notForBot: 2, toolsNotPicked: 3, ready: 4,
};

export interface RecipeConnectorContext {
  /** The library; null while it is still being read. */
  library: readonly (Connector & { missingKeys?: readonly string[] })[] | null;
  botId: string;
  platform: string | undefined;
  /** A signed-in connection's sign-in: true signed in, false not, undefined
   *  not read yet. */
  signedIn: (connectorId: string) => boolean | undefined;
}

export interface RecipeConnectorRow {
  id: BotRecipeConnector;
  name: string;
  state: RecipeConnectorState;
  /** How the connection that state is about authenticates (absent: there
   *  is none yet). */
  via?: 'signIn' | 'key';
}

/** One connection's state for a bot. Pure. */
export function recipeConnectorState(id: BotRecipeConnector, ctx: RecipeConnectorContext): Omit<RecipeConnectorRow, 'id' | 'name'> {
  if (ctx.platform === 'win32') return { state: 'platform' };
  if (!ctx.library) return { state: 'checking' };
  let best: Omit<RecipeConnectorRow, 'id' | 'name'> = { state: 'signIn' };
  for (const c of ctx.library) {
    if (!connectorServes(id, c)) continue;
    // Signed in, or keyed: the gateway's own test (isSignInService).
    const via = isSignInService(c) ? 'signIn' as const : 'key' as const;
    const signed = via === 'signIn' ? ctx.signedIn(c.id) : (c.missingKeys ?? []).length === 0;
    let state: RecipeConnectorState;
    if (signed === false) state = 'signIn';
    else if (signed === undefined) state = 'checking';
    else if (connectorsForBot([c], ctx.botId).length === 0) state = 'notForBot';
    else if (c.tools.mode === 'listed' ? c.tools.allowed.length === 0 : via === 'signIn') state = 'toolsNotPicked';
    else state = 'ready';
    // The first connection found replaces "none yet" even at the same step.
    if (best.via === undefined || PROGRESS[state] > PROGRESS[best.state]) best = { state, via };
  }
  return best;
}

/** Each connection a recipe needs, its name and its state for one bot. Pure. */
export function recipeChecklist(r: Pick<BotRecipe, 'connectors'>, ctx: RecipeConnectorContext): RecipeConnectorRow[] {
  return r.connectors.map((id) => ({ id, name: recipeConnectorName(id) ?? id, ...recipeConnectorState(id, ctx) }));
}

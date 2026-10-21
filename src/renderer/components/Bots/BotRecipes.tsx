// ─── Bot recipes: the Add bot picker and the profile's checklist ───────────
//
// A recipe (shared/botRecipes.ts) prefills a new bot's job and names the
// connections that job needs; it grants nothing. Add bot shows a Recipe
// select over the template chips, with one muted line on what the recipe
// reads and what it needs. The bot keeps the recipe's id, and its profile
// lists each of those connections with where it stands — checking, sign in
// (or key) needed, not given to this bot, tools not picked, ready to try, or
// macOS and Linux only — each a link to Plugins › Connectors, where the owner
// sets it up.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import Select from '../ui/Select';
import { botTemplate, type BotProfile } from '../../../shared/bot';
import type { ConnectorView } from '../../../shared/botConnector';
import type { ConnectorOAuthStatus } from '../../../shared/connectorOAuth';
import {
  BOT_RECIPES,
  botRecipe,
  connectorServes,
  recipeChecklist,
  recipeConnectorName,
  recipeConnectorNeedsOwnClient,
  recipeNeedsOwnClient,
  type BotRecipe,
  type RecipeConnectorRow,
} from '../../../shared/botRecipes';
import { CONNECTOR_SERVICES, isSignInService } from '../../../shared/connectorServices';
import { getBotConnectorPort, useBotConnectors, type BotConnectorPort } from '../Room/botConnectors';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The connection names a recipe lists, joined for one line. */
function connectionNames(r: Pick<BotRecipe, 'connectors'>): string {
  return r.connectors.map((id) => recipeConnectorName(id) ?? id).join(', ');
}

/** The job a recipe prefills, in the owner's language: what it asks for,
 *  then how to work (the research preset, its connections only, files
 *  through Bash, reads only, writes drafted in the chat) and what to say
 *  when a worker is refused. Pure. */
export function recipeJob(r: BotRecipe, t: T): string {
  return [
    t(r.jobKey),
    t('botRecipes.common.work', { connections: connectionNames(r) }),
    t('botRecipes.common.refused'),
  ].join('\n\n');
}

/** The recipe groups of the picker, in catalog order: one-click sign-in,
 *  a key (the GitHub preset), the owner's own OAuth client. */
function recipeGroup(r: BotRecipe): 'oneClick' | 'key' | 'ownClient' {
  if (recipeNeedsOwnClient(r)) return 'ownClient';
  return r.connectors.every((id) => CONNECTOR_SERVICES.some((s) => s.id === id)) ? 'oneClick' : 'key';
}

/** Add bot's Recipe row: a native select (None, then the recipes by how
 *  they sign in) and, once one is picked, one muted line on what it reads,
 *  what it needs and that nothing is connected for it here. */
export function RecipePicker({ value, onChange, t, platform }: {
  value: string | null;
  onChange: (recipe: BotRecipe | null) => void;
  t: T;
  platform?: string;
}): React.ReactElement {
  const picked = botRecipe(value);
  const groups = (['oneClick', 'key', 'ownClient'] as const).map((g) => ({ g, items: BOT_RECIPES.filter((r) => recipeGroup(r) === g) }));
  return (
    <>
      <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0">{t('settings.factory.addBotRecipe')}</span>
        <Select
          data-testid="factory-add-bot-recipe"
          value={picked?.id ?? ''}
          onChange={(e) => onChange(botRecipe(e.target.value) ?? null)}
        >
          <option value="">{t('settings.factory.addBotRecipeNone')}</option>
          {groups.map(({ g, items }) => (
            <optgroup key={g} label={t(`settings.factory.addBotRecipeGroup.${g}`)}>
              {items.map((r) => <option key={r.id} value={r.id}>{t(r.titleKey)}</option>)}
            </optgroup>
          ))}
        </Select>
      </label>
      {picked && (
        <div data-testid="factory-add-bot-recipe-note" className="pl-[128px] text-[11px] text-[var(--text-muted)]">
          {t(picked.hintKey)}
          {' '}
          {t('settings.factory.addBotRecipeReads', { connections: connectionNames(picked) })}
          {recipeNeedsOwnClient(picked) && ` ${t('settings.factory.addBotRecipeOwnClient')}`}
          {platform === 'win32' && ` ${t('settings.factory.addBotRecipePlatform')}`}
          {' '}
          {t('settings.factory.addBotRecipeSetup')}
        </div>
      )}
    </>
  );
}

/** A sign-in status as the checklist reads it: signed in, not, or not
 *  known yet. 'expired' is signed in: only the access token lapsed, and
 *  main refreshes it when a worker starts (the gateway decides by the stored
 *  sign-in, not the token's age), as Plugins › Connectors shows it.
 *  'authorizing' (a sign-in in flight) is not known yet: read again. Pure. */
export function signedInOf(status: ConnectorOAuthStatus | undefined): boolean | undefined {
  if (status === undefined || status === 'authorizing') return undefined;
  return status === 'authorized' || status === 'expired';
}

type OAuthAction = (action: 'status', id: string) => Promise<{ status: ConnectorOAuthStatus }>;

function oauthBridge(): OAuthAction | undefined {
  const api = (globalThis as { electronAPI?: { connectorOAuth?: { action?: OAuthAction } } }).electronAPI;
  return api?.connectorOAuth?.action;
}

/** How long a sign-in in flight waits before it is read again, and how
 *  often (the Connectors page polls its own every 2 s). */
const AUTHORIZING_REREAD_MS = 2000;
const AUTHORIZING_REREADS = 30;

/** The sign-in status of each signed-in connection a recipe names, read
 *  again whenever one of them changes, and again while a sign-in is in
 *  flight ('authorizing'). Without the sign-in bridge every one reads
 *  'unavailable': not signed in, never "checking" for good. */
function useSignIns(r: BotRecipe, library: readonly ConnectorView[] | null, status: OAuthAction | undefined): Record<string, ConnectorOAuthStatus> {
  const services = useMemo(
    () => (library ?? []).filter((c) => isSignInService(c) && r.connectors.some((id) => connectorServes(id, c))),
    [library, r],
  );
  const key = services.map((c) => `${c.id}:${c.updatedAt}`).join(',');
  const [statuses, setStatuses] = useState<Record<string, ConnectorOAuthStatus>>({});
  const [rereads, setRereads] = useState(0);
  useEffect(() => setRereads(0), [key]);
  useEffect(() => {
    if (services.length === 0) return undefined;
    if (!status) {
      setStatuses(Object.fromEntries(services.map((c) => [c.id, 'unavailable' as const])));
      return undefined;
    }
    let live = true;
    let timer: number | undefined;
    void Promise.all(services.map((c) => status('status', c.id).then((res) => res.status, () => 'unavailable' as const))).then((read) => {
      if (!live) return;
      setStatuses((cur) => ({ ...cur, ...Object.fromEntries(services.map((c, i) => [c.id, read[i]])) }));
      if (read.includes('authorizing') && rereads < AUTHORIZING_REREADS) timer = window.setTimeout(() => setRereads((n) => n + 1), AUTHORIZING_REREAD_MS);
    });
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
    // `key` names the connections and their versions; `services` follows it.
  }, [key, status, rereads]);
  return statuses;
}

function openConnectors(): void {
  useStore.getState().setAppRoute('connectors');
}

/** The state word of one checklist row: a keyed connection (the GitHub
 *  preset, or a service set up with a key) needs its key, not a sign-in. */
function stateLabel(row: RecipeConnectorRow, t: T): string {
  const keyed = row.via === 'key' || (row.via === undefined && !CONNECTOR_SERVICES.some((s) => s.id === row.id));
  if (row.state === 'signIn' && keyed) return t('botsPage.profile.recipeState.keyNeeded');
  if (row.state === 'ready' && row.via === 'key') return t('botsPage.profile.recipeState.readyKey');
  return t(`botsPage.profile.recipeState.${row.state}`);
}

/** The profile's Recipe row: the recipe's name, then one line per
 *  connection it needs with its state for this bot, each a link to Plugins ›
 *  Connectors. Nothing for a bot made without a recipe, or one whose
 *  template has changed since (the recipe no longer describes it). */
export function BotRecipeChecklist(props: {
  bot: Pick<BotProfile, 'id' | 'recipe' | 'template' | 'role'>;
  t: T;
  port?: BotConnectorPort;
  oauthStatus?: OAuthAction;
  platform?: string;
}): React.ReactElement | null {
  const r = botRecipe(props.bot.recipe);
  if (!r || botTemplate(props.bot) !== r.template) return null;
  return <RecipeChecklist {...props} recipe={r} />;
}

function RecipeChecklist({ bot, recipe: r, t, port = getBotConnectorPort(), oauthStatus = oauthBridge(), platform }: {
  bot: Pick<BotProfile, 'id'>;
  recipe: BotRecipe;
  t: T;
  port?: BotConnectorPort;
  oauthStatus?: OAuthAction;
  platform?: string;
}): React.ReactElement {
  const { connectors, loaded } = useBotConnectors(port);
  // Until the library is read nothing is known: "Checking…", never a
  // "Sign in needed" that flips a moment later. A build without the library
  // reads as an empty one.
  const library = !port.available ? [] : loaded ? connectors : null;
  const statuses = useSignIns(r, library, oauthStatus);
  const os = platform ?? (globalThis as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  const rows = recipeChecklist(r, { library, botId: bot.id, platform: os, signedIn: (id) => signedInOf(statuses[id]) });
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-recipe={r.id}>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.recipe')}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[var(--text-main)]">{t(r.titleKey)}</p>
        <ul className="space-y-0.5">
          {rows.map((row) => {
            const label = stateLabel(row, t);
            const ownClient = row.state === 'signIn' && row.via !== 'key' && recipeConnectorNeedsOwnClient(row.id);
            return (
              <li key={row.id} data-recipe-connector={row.id} data-state={row.state} className="flex items-baseline gap-2">
                <span className={`min-w-0 truncate ${row.state === 'ready' ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>{row.name}</span>
                <button
                  type="button"
                  data-testid={`bot-recipe-state-${row.id}`}
                  title={t('botsPage.profile.recipeOpen')}
                  onClick={openConnectors}
                  className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                >
                  {ownClient ? `${label} · ${t('botsPage.profile.recipeOwnClient')}` : label}
                </button>
              </li>
            );
          })}
        </ul>
        {rows.some((row) => row.state !== 'ready' && row.state !== 'checking' && row.state !== 'platform') && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.recipeHint')}</p>}
        {rows.some((row) => row.state === 'ready') && <p data-recipe-ready-note className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.recipeReadyNote')}</p>}
      </div>
    </div>
  );
}

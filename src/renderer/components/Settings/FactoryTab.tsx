// ─── Settings › Factory ──────────────────────────────────────────────────────
//
// The agent factory's few switches (factory/settings.json, owned by the bot
// runtime), read and written through the factory settings port: on/off,
// trusted PR authors, the morning report time, whether the
// Verifier runs on the owner's own PRs, the engine new bots run on, the
// factory-wide cap on bots in a turn and the merge lane's auto-merge switch
// and daily cap — then each workspace's bots (named as the bot port lists
// them, each with its avatar and template), with a
// small profile editor when the bot port can update them (name, job,
// picture, switch and budget; the repository is shown, not changed), and
// "Add bot" (workspace and name; optionally a picture, a recipe or a
// template chip that prefills the job, the job and a repository) when the bot port can create
// them. A workspace works on one repository: once a bot there has one, a new
// bot takes it; before that, main suggests the workspace's own folder, shown
// as "Works on <repo>" with Change and None (nothing is attached unseen).
// Adding a bot while the bots are off turns them on, after one inline
// confirm. A disabled Add says why in one line. A picture is
// picked in main's image dialog and comes back as a preview; it is saved
// with the new bot, or on the editor's Save. Without the
// factory in this build the rows are shown switched off, and one note says
// so. Turning the factory on or off re-reads the room dock's gate.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { BOT_JOB_MAX, BOT_NAME_MAX, TEMPLATE_LEGACY_ROLE, isCoordinatorBot, normalizeBotJob, normalizeBotName, type BotProfile, type BotRole, type BotTemplate } from '../../../shared/bot';
import { TEAM_TEMPLATES, teamTemplatesPresent, type FactoryBotAvatarPickResult, type FactoryBotRepoSuggestion } from '../../../shared/botCreate';
import { FACTORY_LANE_DAILY_CAP_MAX } from '../../../shared/factorySettings';
import type { FactoryTaskFolderUsage } from '../../../shared/botTask';
import { getLocale } from '../../i18n';
import { refreshRoomStatus } from '../../hooks/useRoomSync';
import {
  getFactoryBotPort,
  getFactorySettingsPort,
  type FactoryBotPort,
  type FactoryBotRow,
  type FactorySettingsPort,
  type FactorySettingsView,
} from '../Room/factoryPorts';
import { useFactoryBots } from '../Room/useFactoryBots';
import { PresenceDot, botPresence } from '../Room/BotChips';
import BotAvatar from '../Room/BotAvatar';
import { botKindLabel, templateLabel } from '../Room/roomFormat';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';
import { ApprovalRules } from './ApprovalRules';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Select from '../ui/Select';
import Input from '../ui/Input';
import { FOCUS_RING } from '../focusRing';
import { originCommand } from '../Git/originCommand';
import { useCopyText } from '../../hooks/useCopyText';
import { BotSecretsSection, PhoneBotSelect } from './BotSecretsSection';
import { BotConnectionsSection } from './BotConnectionsSection';
import { ClaudeAuthSection, bridgeClaudeAuthPort, type ClaudeAuthPort } from './ClaudeAuthSection';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { AddBotEngineRow } from '../Bots/BotEngineLine';
import type { EnginePick, HermesPort } from '../Bots/botsHermes';
import { selectBotTaskOwners, withoutBotTasks } from '../Sidebar/botTasks';
import { listedWorkspaces } from '../../../shared/pcRail';
import { createBot, turnBotsOn, type TurnBotsOnResult } from '../Bots/botsAddBot';
import { botsOnPatch, useBotsPlanConsent } from '../Bots/BotsPlanConsent';
import { botsStopPort, toastStoppedWork } from '../Bots/botsStop';
import { botModelSummary } from '../Bots/botsProfile';
import { RecipePicker, recipeJob } from '../Bots/BotRecipes';
import type { BotRecipe } from '../../../shared/botRecipes';

type T = (key: string, vars?: Record<string, string | number>) => string;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const CONCURRENCY = [1, 2, 3, 4, 5];
/** shared/factorySettings.ts FACTORY_MAX_AGENTS_MIN..MAX. */
const MAX_AGENTS = Array.from({ length: 15 }, (_, i) => i + 2);

/** A comma / space separated list of logins → the list. */
export function parseAuthors(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean))];
}

/** The daily cap typed in the field → a whole number in range, or null. */
export function parseDailyCap(text: string): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isInteger(n) || n < 0) return null;
  return Math.min(n, FACTORY_LANE_DAILY_CAP_MAX);
}

/** A failed pick as the line the form shows (cancelled: none). */
export function avatarPickError(r: FactoryBotAvatarPickResult, t: T): string | null {
  if (r.ok || r.code === 'cancelled') return null;
  return t(r.code === 'too_large' ? 'settings.factory.pictureTooLarge' : 'settings.factory.pictureUnreadable');
}

/** Choose / preview / remove a picture. `avatar` is the picture shown now
 *  (a preview or the saved one). */
function PicturePicker({ bot, avatar, port, t, busy, onPicked, onRemove, onError, chooseLabel, removeLabel, unmade = false }: {
  bot: { id: string; name: string; role: BotRole };
  /** The bot is not made yet: no colour or shape to promise. */
  unmade?: boolean;
  avatar: string | undefined;
  port: FactoryBotPort;
  t: T;
  busy: boolean;
  onPicked: (avatar: string) => void;
  onRemove: () => void;
  onError: (message: string | null) => void;
  chooseLabel: string;
  removeLabel: string;
}) {
  const pick = async () => {
    if (!port.pickAvatar) return;
    try {
      const r = await port.pickAvatar();
      if (r.ok) { onPicked(r.avatar); onError(null); }
      else { const msg = avatarPickError(r, t); if (msg) onError(msg); }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
      <span className="w-[120px] shrink-0">{t('settings.factory.picture')}</span>
      <span data-testid="factory-picture-preview" className="inline-flex"><BotAvatar bot={{ ...bot, avatar }} size={32} t={t} placeholder={unmade} /></span>
      <Button size="sm" variant="secondary" data-testid="factory-picture-choose" onClick={() => void pick()} disabled={busy}>
        {chooseLabel}
      </Button>
      {avatar && (
        <Button size="sm" variant="ghost" data-testid="factory-picture-remove" onClick={onRemove} disabled={busy}>
          {removeLabel}
        </Button>
      )}
    </div>
  );
}

/** `github.com/acme/app` → `acme/app`; a repo on another host keeps it. */
export function repoKeyLabel(repoKey: string): string {
  return repoKey.startsWith('github.com/') ? repoKey.slice('github.com/'.length) : repoKey;
}

/** "acme/app · ~/code/app": the repository, then its folder (mono). */
function RepoLine({ repoKey, folder, testId }: { repoKey: string; folder: string; testId: string }) {
  return (
    <span data-testid={testId} title={`${repoKey} · ${folder}`} className="flex min-w-0 items-baseline gap-1.5 text-[13px] text-[var(--text-main)]">
      <span className="shrink-0">{repoKeyLabel(repoKey)}</span>
      <span aria-hidden="true" className="text-[var(--text-muted)]">·</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-sub)]">{folder}</span>
    </span>
  );
}

/** The templates "Add bot" offers as chips, in order (Custom is the
 *  default when none is picked). */
export const ADDABLE_TEMPLATES: readonly BotTemplate[] = ['coordinator', 'developer', 'reviewer', 'issue', 'researcher'];

/** The job text a template chip prefills (none for Custom). */
export function templateJob(template: BotTemplate | null, t: T): string {
  return template && template !== 'custom' ? t(`botsPage.templateJob.${template}`) : '';
}

/** The repository a workspace's listed bots already work on (the oldest
 *  repo bot's), or null. Main holds the same rule (botCreate.ts
 *  workspaceRepo) and enforces it. */
export function workspaceRepoOf(rows: readonly FactoryBotRow[], workspaceId: string): { repoKey: string; repoPath: string } | null {
  const withRepo = rows.filter((r) => r.bot.workspaceId === workspaceId && r.bot.repo).sort((a, b) => a.bot.createdAt - b.bot.createdAt);
  return withRepo[0]?.bot.repo ?? null;
}

/** What "Add bot" shows for the repository: the workspace's (inherited, no
 *  picker), main's suggestion (with Change…), the folder the owner picked,
 *  main's answer still on its way (`checking`: nothing can be added yet), or
 *  none: with why main's suggestion was refused (`reason`, its fix in
 *  main's words), `remembered` when the owner chose no repository for the
 *  workspace before, or `unchecked` when main could not be asked (`failed`)
 *  or did not answer in time (`slow`). */
export type AddBotRepoView =
  | { kind: 'inherited'; repoKey: string; root: string; displayRoot: string }
  | { kind: 'suggested'; repoKey: string; root: string; displayRoot: string }
  | { kind: 'picked'; folder: string }
  | { kind: 'checking' }
  | { kind: 'none'; reason?: string; reasonCode?: string; originSet?: boolean; remembered?: boolean; unchecked?: 'failed' | 'slow' };

export function addBotRepoView(
  rows: readonly FactoryBotRow[],
  workspaceId: string,
  suggestion: FactoryBotRepoSuggestion | null,
  folder: string | null,
  /** The owner pressed None: no repository (an inherited one still holds:
   *  main gives every bot of the workspace its repository). */
  none = false,
  /** Main's suggestion was asked and has not answered yet. */
  pending = false,
  /** Main could not be asked, or did not answer in time. */
  unchecked: 'failed' | 'slow' | null = null,
): AddBotRepoView {
  const s = suggestion?.ok ? suggestion : null;
  const own = workspaceRepoOf(rows, workspaceId);
  if (own) {
    const displayRoot = s?.inherited && s.root === own.repoPath ? s.displayRoot : own.repoPath;
    return { kind: 'inherited', repoKey: own.repoKey, root: own.repoPath, displayRoot };
  }
  if (s?.inherited) return { kind: 'inherited', repoKey: s.repoKey, root: s.root, displayRoot: s.displayRoot };
  if (none) return { kind: 'none' };
  if (folder) return { kind: 'picked', folder };
  if (s) return { kind: 'suggested', repoKey: s.repoKey, root: s.root, displayRoot: s.displayRoot };
  if (unchecked) return { kind: 'none', unchecked };
  if (pending) return { kind: 'checking' };
  if (suggestion && !suggestion.ok) {
    if (suggestion.code === 'none') return { kind: 'none', remembered: true };
    if (suggestion.message) return { kind: 'none', reason: suggestion.message, reasonCode: suggestion.code, ...(suggestion.originSet ? { originSet: true } : {}) };
  }
  return { kind: 'none' };
}

/** The folder picker: the app's own dialog, the first folder or null. */
export async function pickFolderDialog(): Promise<string | null> {
  const api = (globalThis as { electronAPI?: { dialog?: { pickFolder?: () => Promise<string[]> } } }).electronAPI;
  const picked = await api?.dialog?.pickFolder?.();
  return picked && picked.length > 0 ? picked[0] : null;
}

type Workspaces = readonly { id: string; name: string }[];

/** A port that lists nothing (the form was handed its rows). */
const NO_LIST_PORT: FactoryBotPort = { available: false, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: false }) };

export interface AddBotFormProps {
  /** Called with the new bot after it was added (a team: the lead made
   *  here, or none when the lead was there already, and the whole team, its
   *  lead first), and with nothing on Cancel. */
  onDone: (bot?: BotProfile, team?: readonly BotProfile[]) => void;
  /** The rest default to the app's own: the bot port, its bots, the store's
   *  workspaces (the active one first picked) and the folder dialog. */
  t?: T;
  port?: FactoryBotPort;
  rows?: readonly FactoryBotRow[];
  workspaces?: Workspaces;
  defaultWorkspaceId?: string;
  pickFolder?: () => Promise<string | null>;
  /** The bots are off: Add asks once, in place, then turns them on. */
  botsOff?: boolean;
  /** Turns the bots on, asking the plan consent when needed (default: the
   *  factory settings port, which turns them on only with consent stored). */
  turnOn?: () => Promise<TurnBotsOnResult>;
  /** 'team': only the workspace and the repository, and Add team as the
   *  primary (the Bots page's "+" › Add team). Default: one bot. */
  mode?: 'bot' | 'team';
  /** The engine picker's Hermes verbs (default: the preload's). */
  hermesPort?: HermesPort;
}

/** Why Add cannot be pressed, as one line's key, or null. Pure. */
export function addBotBlockedReason(p: { canCreate: boolean; workspaceId: string; name: string; jobOk: boolean; repoPending?: boolean }): string | null {
  if (!p.canCreate) return 'settings.factory.notStarted';
  if (!p.workspaceId) return 'settings.factory.addBotNeedWorkspace';
  if (p.name.trim() === '') return 'settings.factory.addBotNeedName';
  if (!normalizeBotName(p.name)) return 'settings.factory.addBotBadName';
  if (!p.jobOk) return 'settings.factory.addBotBadJob';
  if (p.repoPending) return 'settings.factory.addBotRepoChecking';
  return null;
}

/** "Works on acme/app · ~/code/app" with Change and None, or "No
 *  repository" with Choose folder…: what a new bot will work on, always in
 *  view (addBotRepoView). Shared with the Bots page's first screen. */
export function AddBotRepoRow({ view, t, busy, onChoose, onNone, onRecheck }: {
  view: AddBotRepoView;
  t: T;
  busy: boolean;
  onChoose: () => void;
  onNone: () => void;
  /** Ask main for the workspace's folder again (after its origin is fixed). */
  onRecheck?: () => void;
}): React.ReactElement {
  const works = view.kind !== 'none' && view.kind !== 'checking';
  return (
    <div data-testid="factory-add-bot-repo-row" data-repo-kind={view.kind} data-repo-remembered={view.kind === 'none' && view.remembered ? 'true' : undefined} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      {works && <span className="shrink-0 text-[12px] text-[var(--text-sub)]">{t('settings.factory.addBotWorksOn')}</span>}
      {(view.kind === 'inherited' || view.kind === 'suggested') && (
        <RepoLine repoKey={view.repoKey} folder={view.displayRoot} testId="factory-add-bot-repo" />
      )}
      {view.kind === 'picked' && <span data-testid="factory-add-bot-path" className="min-w-0 truncate font-mono text-[11px] text-[var(--text-main)]" title={view.folder}>{view.folder}</span>}
      {view.kind === 'checking' && <span data-testid="factory-add-bot-repo-checking" className="shrink-0 text-[12px] text-[var(--text-muted)]">{t('settings.factory.addBotRepoChecking')}</span>}
      {view.kind === 'none' && <span data-testid="factory-add-bot-no-repo" className="shrink-0 text-[13px] text-[var(--text-main)]">{t('settings.factory.addBotNoRepo')}</span>}
      {view.kind !== 'inherited' && (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" data-testid="factory-add-bot-folder" onClick={onChoose} disabled={busy}>
            {t(works ? 'settings.factory.addBotChangeFolder' : 'settings.factory.addBotChooseFolder')}
          </Button>
          {works && (
            <Button size="sm" variant="ghost" data-testid="factory-add-bot-repo-none" onClick={onNone} disabled={busy}>
              {t('settings.factory.addBotRepoNone')}
            </Button>
          )}
        </span>
      )}
      {view.kind === 'none' && view.unchecked && (
        <p
          data-testid="factory-add-bot-repo-reason"
          data-repo-unchecked={view.unchecked}
          {...(view.unchecked === 'failed' ? { role: 'alert' } : {})}
          className={`basis-full text-[11px] leading-snug ${view.unchecked === 'failed' ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}
        >
          {t(view.unchecked === 'failed' ? 'settings.factory.addBotRepoCheckFailed' : 'settings.factory.addBotRepoCheckSlow')}
        </p>
      )}
      {view.kind === 'none' && !view.unchecked && view.reasonCode === 'no_remote' && view.reason && (
        <RepoNoRemoteNote reason={view.reason} originSet={view.originSet} onRecheck={onRecheck} t={t} />
      )}
      {view.kind === 'none' && !view.unchecked && view.reasonCode !== 'no_remote' && (view.reason || view.remembered) && (
        <p data-testid="factory-add-bot-repo-reason" className="basis-full text-[11px] leading-snug text-[var(--text-muted)]">
          {view.reason ?? t('settings.factory.addBotRepoRemembered')}
        </p>
      )}
    </div>
  );
}

/** A folder whose origin a bot cannot push to: one plain line, the command
 *  that sets origin (add, or set-url when origin names no host), Check
 *  again (asks main once more, so a fixed folder is offered), and main's
 *  full reason behind Show details. "Copied" only once the write went
 *  through; a failed copy shows the command to select by hand. */
function RepoNoRemoteNote({ reason, originSet, onRecheck, t }: { reason: string; originSet?: boolean; onRecheck?: () => void; t: T }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { state: copyState, copy } = useCopyText();
  const command = originCommand(originSet);
  const link = `hover:text-[var(--text-main)] ${FOCUS_RING}`;
  return (
    <div data-testid="factory-add-bot-repo-reason" data-repo-reason="no_remote" className="flex basis-full flex-col gap-1">
      <p className="text-[12px] leading-snug text-[var(--text-sub)]">{t('settings.factory.addBotRepoNoRemote')}</p>
      <span className="flex flex-wrap items-center gap-x-1 text-[12px] text-[var(--text-muted)]">
        <button type="button" data-testid="factory-add-bot-repo-copy" data-copy-state={copyState} title={command} className={link} onClick={() => void copy(command)}>
          {copyState === 'copied' ? t('git.connect.copied') : t('settings.factory.addBotRepoCopyCommand')}
        </button>
        {onRecheck && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" data-testid="factory-add-bot-repo-recheck" className={link} onClick={onRecheck}>
              {t('botsPage.onboarding.checkAgain')}
            </button>
          </>
        )}
        <span aria-hidden="true">·</span>
        <button type="button" data-testid="factory-add-bot-repo-details" aria-expanded={open} className={link} onClick={() => setOpen((v) => !v)}>
          {t(open ? 'botsPage.engineError.hideDetails' : 'botsPage.engineError.showDetails')}
        </button>
      </span>
      {copyState === 'failed' && <code data-testid="factory-add-bot-repo-command" className="select-all break-all font-mono text-[11px] text-[var(--text-main)]">{command}</code>}
      {open && <p data-testid="factory-add-bot-repo-detail" className="break-words text-[11px] leading-snug text-[var(--text-muted)]">{reason}</p>}
    </div>
  );
}

/** How long the form waits for main's suggestion before it lets the owner
 *  add without one. */
export const REPO_SUGGEST_TIMEOUT_MS = 10_000;

/** What "Add bot" shows for a workspace's repository and what it sends:
 *  main's suggestion (the chosen workspace's folder, asked again when the
 *  workspace, its bots' repo or its folders change), a picked folder, or
 *  None. Everything here belongs to the workspace it was given for: a folder
 *  picked (or None pressed) for one workspace is never shown or sent for
 *  another, and choosing another workspace starts from its own suggestion.
 *  Shared with the first screen. Main's answer belongs to the ask it answers (the
 *  workspace and what triggered it): a new ask reads as `pending` on the
 *  same render, and Add waits (an add then would make a bot without the
 *  workspace's repository), for REPO_SUGGEST_TIMEOUT_MS at most. `request`
 *  is what a create sends: the folder; `noRepo` when the owner pressed None
 *  (main remembers it, so the next add does not ask); `noInherit` when main
 *  could not be asked or did not answer in time (the bot gets no repository
 *  it was not shown). A refusal alone sends nothing, so a folder fixed later
 *  is offered again. */
export function useAddBotRepo(port: FactoryBotPort, rows: readonly FactoryBotRow[], workspaceId: string, pickFolder: () => Promise<string | null>) {
  // The owner's own choice, kept with the workspace it was made for.
  const [choice, setChoice] = useState<{ workspaceId: string; folder: string | null; none: boolean } | null>(null);
  const mine = choice?.workspaceId === workspaceId ? choice : null;
  const folder = mine?.folder ?? null;
  const none = mine?.none ?? false;
  const [answer, setAnswer] = useState<{ ask: string; suggestion: FactoryBotRepoSuggestion | null; unchecked: 'failed' | 'slow' | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const own = workspaceRepoOf(rows, workspaceId);
  const ownKey = own ? `${own.repoKey}\n${own.repoPath}` : '';
  // Main's suggestion for the workspace, asked again when its bots' repo or
  // its folders change (they only trigger the ask; main reads its own).
  const shownCwd = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.metadata?.cwd ?? '');
  const shownStartup = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.profile?.startupCwd ?? '');
  // Check again: the same workspace asked once more (its folder's origin may
  // have been fixed since).
  const [recheckSeq, setRecheckSeq] = useState(0);
  const ask = [workspaceId, ownKey, shownCwd, shownStartup, recheckSeq].join('\0');
  useEffect(() => {
    if (!port.suggestRepo || !workspaceId) return;
    let live = true;
    const settle = (suggestion: FactoryBotRepoSuggestion | null, unchecked: 'failed' | 'slow' | null) => {
      if (live) setAnswer({ ask, suggestion, unchecked });
    };
    port.suggestRepo(workspaceId).then((s) => settle(s, null), () => settle(null, 'failed'));
    // Too slow: the owner may add without one (never inheriting one unseen).
    const timer = setTimeout(() => {
      if (live) setAnswer((a) => (a?.ask === ask ? a : { ask, suggestion: null, unchecked: 'slow' }));
    }, REPO_SUGGEST_TIMEOUT_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [port, workspaceId, ask]);
  const asked = !!port.suggestRepo && !!workspaceId;
  const current = answer?.ask === ask ? answer : null;
  const view = addBotRepoView(rows, workspaceId, current?.suggestion ?? null, folder, none, asked && !current, current?.unchecked ?? null);
  const repoFolder = view.kind === 'picked' ? view.folder : view.kind === 'suggested' ? view.root : undefined;
  const request: { repoFolder?: string; noRepo?: true; noInherit?: true } = repoFolder
    ? { repoFolder }
    : view.kind === 'none' && none
      ? { noRepo: true }
      : view.kind === 'none' && view.unchecked
        ? { noInherit: true }
        : {};
  const choose = async () => {
    // A folder is the workspace's that was chosen when the picker opened.
    const forWorkspace = workspaceId;
    try {
      const picked = await pickFolder();
      if (picked) { setChoice({ workspaceId: forWorkspace, folder: picked, none: false }); setError(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return { view, repoFolder, request, pending: view.kind === 'checking', choose, chooseNone: () => setChoice({ workspaceId, folder: null, none: true }), recheck: () => setRecheckSeq((n) => n + 1), error };
}

/** The names "Add team" gives its bots, in the owner's language. */
export function teamNames(t: T): Record<string, string> {
  return Object.fromEntries(TEAM_TEMPLATES.map((tpl) => [tpl, t(`botsPage.teamName.${tpl}`)]));
}

/** What "Add team" makes in a workspace: the team templates none of its
 *  enabled bots has yet (`missing`; main skips the `present` ones by the
 *  same rule). Every template is named in the owner's language, with a
 *  number when a bot there already has that name ("Developer 2"): main uses
 *  the missing ones' names, and a role gone meanwhile still has one. The
 *  missing ones are named first. Pure. */
export function teamPlan(rows: readonly FactoryBotRow[], workspaceId: string, t: T): { missing: BotTemplate[]; present: BotTemplate[]; names: Record<string, string> } {
  const here = rows.filter((r) => r.bot.workspaceId === workspaceId).map((r) => r.bot);
  const present = teamTemplatesPresent(here);
  const missing = TEAM_TEMPLATES.filter((tpl) => !present.includes(tpl));
  const taken = new Set(here.map((b) => b.name.toLocaleLowerCase()));
  const names: Record<string, string> = {};
  for (const tpl of [...missing, ...present]) {
    const base = t(`botsPage.teamName.${tpl}`);
    let name = base;
    for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLocaleLowerCase());
    names[tpl] = name;
  }
  return { missing, present, names };
}

/** The workspace's whole team after "Add team" made `made`: its bots of a
 *  team template, the coordinator first (what the group chat offer ticks). */
function teamAfter(rows: readonly FactoryBotRow[], workspaceId: string, made: readonly BotProfile[]): BotProfile[] {
  const madeIds = new Set(made.map((b) => b.id));
  const all = [...rows.map((r) => r.bot).filter((b) => b.workspaceId === workspaceId && !madeIds.has(b.id)), ...made];
  return TEAM_TEMPLATES.flatMap((tpl) => all.filter((b) => teamTemplatesPresent([b])[0] === tpl));
}

/** "Add bot": a workspace and a name, optionally a picture, a template
 *  chip that prefills the job, the job itself and the repository
 *  (addBotRepoView; optional, always shown). Main derives the repo from the
 *  folder sent (none for an inherited one), creates the bot and wakes it
 *  once to greet the owner. Self-contained, so any page can host it. */
export function AddBotForm(props: AddBotFormProps): React.ReactElement {
  const ownT = useT();
  const t = props.t ?? ownT;
  const port = props.port ?? getFactoryBotPort();
  const listed = useFactoryBots(null, props.rows ? NO_LIST_PORT : port);
  const rows = props.rows ?? listed;
  const storeWorkspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = props.workspaces ?? storeWorkspaces;
  const wanted = props.defaultWorkspaceId ?? activeWorkspaceId;
  const defaultWorkspaceId = workspaces.some((w) => w.id === wanted) ? wanted : workspaces[0]?.id ?? '';
  const pickFolder = props.pickFolder ?? pickFolderDialog;
  const onDone = props.onDone;
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  // A recipe sets the template and prefills the job; it grants nothing.
  const [recipe, setRecipe] = useState<BotRecipe | null>(null);
  const [job, setJob] = useState('');
  // The text the last chip put in the job field: a chip replaces the job
  // only while the owner has not written their own.
  const prefilled = useRef('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The bots are off: Add (or Add team) first asks, in place, to turn them on.
  const [confirmOn, setConfirmOn] = useState<'bot' | 'team' | null>(null);
  // The engine: Claude unless the owner picks a Hermes.
  const [engine, setEngine] = useState<EnginePick>({ engine: 'claude-sdk' });
  const repo = useAddBotRepo(port, rows, workspaceId, pickFolder);
  // A name is required; a job is optional but, when written, one the store keeps.
  const typedName = normalizeBotName(name);
  const typedJob = normalizeBotJob(job);
  const jobOk = job.trim() === '' || typedJob !== undefined;
  const blocked = addBotBlockedReason({ canCreate: !!port.create, workspaceId, name, jobOk, repoPending: repo.pending });
  // "Add team": the team bots this workspace is missing (all five for a
  // new team, the lead first), offered while one is missing.
  const teamMode = props.mode === 'team';
  const plan = teamPlan(rows, workspaceId, t);
  const canTeam = !!port.createTeam && !!workspaceId && plan.missing.length > 0;

  const prefill = (fill: string) => {
    if (job.trim() === '' || job === prefilled.current) {
      setJob(fill);
      prefilled.current = fill;
    }
  };
  const pickTemplate = (next: BotTemplate) => {
    const picked = template === next ? null : next;
    setTemplate(picked);
    setRecipe(null);
    prefill(templateJob(picked, t));
  };
  const pickRecipe = (next: BotRecipe | null) => {
    setRecipe(next);
    setTemplate(null);
    prefill(next ? recipeJob(next, t) : '');
  };

  // An edit that makes the form invalid closes the turn-on confirm.
  useEffect(() => { if (blocked) setConfirmOn((c) => (c === 'bot' ? null : c)); }, [blocked]);

  const add = async (turnOnFirst: boolean) => {
    if (!port.create || !typedName || blocked) return;
    setBusy(true);
    setError(null);
    try {
      if (turnOnFirst) {
        const turnOn = props.turnOn ?? (() => turnBotsOn(getFactorySettingsPort(), async () => false));
        const on = await turnOn();
        if (on === 'declined') return;
        if (on !== 'on') { setError(t('settings.factory.notStarted')); return; }
      }
      const r = await createBot(port, {
        workspaceId,
        name: typedName,
        ...(recipe ? { template: recipe.template, recipe: recipe.id } : template ? { template } : {}),
        ...(typedJob ? { job: typedJob } : {}),
        ...repo.request,
        ...(avatar ? { avatar } : {}),
        ...(engine.engine !== 'claude-sdk' ? { engine: engine.engine } : {}),
        ...(engine.engine === 'my-hermes' && engine.profile ? { hermesProfile: engine.profile } : {}),
      });
      if (r.ok) onDone(r.bot);
      // Declined in main's My Hermes confirm: the form stays as it was.
      else if (r.code !== 'cancelled') setError(r.message || t('settings.factory.addBotFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmOn(null);
    }
  };
  const addTeam = async (turnOnFirst: boolean) => {
    if (!port.createTeam || !canTeam || repo.pending) return;
    setBusy(true);
    setError(null);
    try {
      if (turnOnFirst) {
        const turnOn = props.turnOn ?? (() => turnBotsOn(getFactorySettingsPort(), async () => false));
        const on = await turnOn();
        if (on === 'declined') return;
        if (on !== 'on') { setError(t('settings.factory.notStarted')); return; }
      }
      const r = await port.createTeam({ workspaceId, names: plan.names, ...repo.request });
      if (!r.ok) setError(r.message || t('settings.factory.addTeamFailed'));
      else if (r.bots.length === 0) setError(t('settings.factory.addTeamWhole'));
      else {
        // The bots that were there already are named once, in a toast.
        if (r.skipped && r.skipped.length > 0) {
          useStore.getState().pushToast({
            message: t('settings.factory.addTeamPartial', { added: r.bots.map((b) => b.name).join(', '), kept: r.skipped.map((tpl) => templateLabel(tpl, t)).join(', ') }),
            level: 'info',
          });
        }
        // The team's lead is the one to talk to: a lead made here greets and
        // its chat opens; else the page opens the lead it had.
        const lead = r.bots.find((b) => isCoordinatorBot(b));
        onDone(lead, teamAfter(rows, workspaceId, r.bots));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmOn(null);
    }
  };
  const shownError = error ?? repo.error;
  const names = teamNames(t);
  const teamHint = t('settings.factory.addTeamHint', { names: TEAM_TEMPLATES.map((tpl) => names[tpl]).join(', '), lead: names.coordinator });
  // The team form's one line: what Add team makes here, and what is there.
  const teamLine = !workspaceId
    ? ''
    : plan.missing.length === 0
      ? t('settings.factory.addTeamWhole')
      : plan.present.length === 0
        ? teamHint
        : t('settings.factory.addTeamMissing', { names: plan.missing.map((tpl) => plan.names[tpl]).join(', '), kept: plan.present.map((tpl) => templateLabel(tpl, t)).join(', ') });

  return (
    <div data-testid="factory-add-bot" data-mode={teamMode ? 'team' : 'bot'} className="flex flex-col gap-2 px-3 py-2">
      <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0">{t('settings.factory.addBotWorkspace')}</span>
        <Select
          data-testid="factory-add-bot-workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </label>
      {!teamMode && (<>
      <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0">{t('settings.factory.botName')}</span>
        <Input
          data-testid="factory-add-bot-name"
          value={name}
          maxLength={BOT_NAME_MAX}
          placeholder={t('settings.factory.addBotNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 text-[13px]"
        />
      </label>
      {port.pickAvatar && (
        <PicturePicker
          bot={{ id: `new-${workspaceId}`, name: typedName ?? '', role: TEMPLATE_LEGACY_ROLE[template ?? 'custom'] }}
          unmade
          avatar={avatar}
          port={port}
          t={t}
          busy={busy}
          onPicked={setAvatar}
          onRemove={() => setAvatar(undefined)}
          onError={setError}
          chooseLabel={t('settings.factory.choosePicture')}
          removeLabel={t('settings.factory.removePicture')}
        />
      )}
      <RecipePicker value={recipe?.id ?? null} onChange={pickRecipe} t={t} platform={window.electronAPI?.platform} />
      <div className="flex items-start gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0 pt-[3px]">{t('settings.factory.addBotTemplate')}</span>
        <div role="group" aria-label={t('settings.factory.addBotTemplate')} className="flex flex-1 flex-wrap items-center gap-1">
          {ADDABLE_TEMPLATES.map((tpl) => (
            <button
              key={tpl}
              type="button"
              data-testid="factory-add-bot-template"
              data-template={tpl}
              aria-pressed={template === tpl}
              onClick={() => pickTemplate(tpl)}
              className={`h-[24px] px-2 rounded-[var(--chip-radius)] text-[12px] ${template === tpl ? 'bg-[var(--selection-emphasis)] [--text-muted:var(--text-sub)] text-[var(--text-main)]' : 'bg-[var(--selection)] text-[var(--text-sub)] hover:bg-[var(--selection-hover)] hover:[--text-muted:var(--text-subtle)]'} ${FOCUS_RING}`}
            >
              {templateLabel(tpl, t)}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-start gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0 pt-[5px]">{t('settings.factory.addBotJob')}</span>
        <textarea
          data-testid="factory-add-bot-job"
          value={job}
          rows={3}
          maxLength={BOT_JOB_MAX}
          onChange={(e) => setJob(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className={`min-w-0 flex-1 rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-main)] outline-none ${FOCUS_RING}`}
        />
      </label>
      <div className="pl-[128px] text-[11px] text-[var(--text-muted)]">{t('settings.factory.addBotJobHint')}</div>
      </>)}
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0">{t('settings.factory.addBotRepo')}</span>
        <AddBotRepoRow view={repo.view} t={t} busy={busy} onChoose={() => void repo.choose()} onNone={repo.chooseNone} onRecheck={repo.recheck} />
      </div>
      <div className="text-[11px] text-[var(--text-muted)]">
        {t(repo.view.kind === 'inherited' ? 'settings.factory.addBotRepoInherited' : 'settings.factory.addBotRepoHint')}
      </div>
      {!teamMode && <AddBotEngineRow value={engine} onPick={setEngine} t={t} port={props.hermesPort} disabled={busy} />}
      {teamMode && teamLine && <p data-testid="factory-add-team-plan" className="text-[12px] leading-snug text-[var(--text-sub)]">{teamLine}</p>}
      {shownError && <SettingNote tone="danger" role="alert" data-testid="factory-add-bot-error">{shownError}</SettingNote>}
      {confirmOn ? (
        <InlineConfirm
          text={confirmOn === 'team' ? t('settings.factory.addTeamTurnsOn') : t('settings.factory.addBotTurnsOn', { name: typedName ?? '' })}
          confirmLabel={t('settings.factory.addBotTurnOnAndAdd')}
          cancelLabel={t('settings.factory.cancel')}
          busy={busy}
          tone="primary"
          onConfirm={() => void (confirmOn === 'team' ? addTeam(true) : add(true))}
          onCancel={() => setConfirmOn(null)}
          testId="factory-add-bot-on"
        />
      ) : teamMode ? (
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onDone()} disabled={busy}>{t('settings.factory.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="factory-add-team"
            title={teamHint}
            onClick={() => (props.botsOff ? setConfirmOn('team') : void addTeam(false))}
            disabled={busy || !canTeam || repo.pending}
          >
            {t('settings.factory.addTeam')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1.5">
          {blocked && <span data-testid="factory-add-bot-blocked" className="mr-auto min-w-0 truncate text-[11px] text-[var(--text-muted)]">{t(blocked, { max: BOT_NAME_MAX })}</span>}
          {canTeam && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="factory-add-team"
              title={teamLine}
              onClick={() => (props.botsOff ? setConfirmOn('team') : void addTeam(false))}
              disabled={busy || repo.pending}
            >
              {t('settings.factory.addTeam')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onDone()} disabled={busy}>{t('settings.factory.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="factory-add-bot-submit"
            onClick={() => (props.botsOff ? setConfirmOn('bot') : void add(false))}
            disabled={busy || blocked !== null}
          >
            {t('settings.factory.addBotSubmit')}
          </Button>
        </div>
      )}
    </div>
  );
}

function BotsList({ t, port, workspaceName, workspaces, defaultWorkspaceId, pickFolder, botsOff, turnOn }: {
  t: T;
  port: FactoryBotPort;
  workspaceName: (id: string) => string;
  workspaces: Workspaces;
  defaultWorkspaceId: string;
  pickFolder: () => Promise<string | null>;
  botsOff: boolean;
  turnOn: () => Promise<TurnBotsOnResult>;
}) {
  const rows = useFactoryBots(null, port);
  const [adding, setAdding] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, FactoryBotRow[]>();
    for (const r of rows) by.set(r.bot.workspaceId, [...(by.get(r.bot.workspaceId) ?? []), r]);
    return [...by.entries()];
  }, [rows]);
  if (!port.available) return <SettingNote>{t('settings.factory.botsUnavailable')}</SettingNote>;
  const canAdd = !!port.create;
  const addRow = adding && canAdd ? (
    <AddBotForm
      t={t}
      port={port}
      rows={rows}
      workspaces={workspaces}
      defaultWorkspaceId={defaultWorkspaceId}
      pickFolder={pickFolder}
      botsOff={botsOff}
      turnOn={turnOn}
      onDone={() => setAdding(false)}
    />
  ) : canAdd ? (
    <div className="flex justify-end px-3 py-2">
      <Button size="sm" variant="secondary" data-testid="factory-add-bot-open" onClick={() => setAdding(true)}>
        {t('settings.factory.addBot')}
      </Button>
    </div>
  ) : null;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col">
        <SettingNote>{t('settings.factory.noBots')}</SettingNote>
        {addRow}
      </div>
    );
  }
  return (
    <div data-testid="factory-bots" className="flex flex-col">
      {/* A bot's page is on the Bots page, which is there only while the
          bots are on: off, the rows say so instead of leading nowhere. */}
      {botsOff && <p data-testid="factory-bots-off-note" className="px-3 pt-2 text-[11px] text-[var(--text-muted)]">{t('botsPage.settings.botsOffNote')}</p>}
      {groups.map(([ws, list]) => (
        <div key={ws} className="flex flex-col">
          <div className="px-3 pt-2 text-[11px] text-[var(--text-muted)]">{workspaceName(ws)}</div>
          {list.map((row) => (
            <button
              key={row.bot.id}
              type="button"
              data-testid="factory-bot-row"
              data-bot-id={row.bot.id}
              aria-label={t('botsPage.settings.open', { name: row.bot.name })}
              disabled={botsOff}
              onClick={() => useStore.getState().openBotSettings(row.bot.id)}
              className={`group w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] rounded-[6px] hover:bg-[var(--hover-fill)] disabled:hover:bg-transparent ${FOCUS_RING}`}
            >
              <BotAvatar bot={row.bot} size={20} t={t} />
              <PresenceDot presence={botPresence(row)} />
              <span className="truncate text-[var(--text-main)]">{row.bot.name}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{botKindLabel(row.bot, t)}</span>
              {botModelSummary(row.bot, t) && <span data-testid="factory-bot-models" className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{botModelSummary(row.bot, t)}</span>}
              {!row.bot.enabled && <span className="text-[11px] text-[var(--text-muted)]">{t('settings.factory.botOff')}</span>}
              {!botsOff && <span className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)] group-hover:text-[var(--text-main)]">{t('botsPage.settings.openRow')}</span>}
            </button>
          ))}
        </div>
      ))}
      {addRow}
    </div>
  );
}

/** A folder size in the reader's language: MB, or GB from 1 GB. Pure. */
export function taskFolderSize(bytes: number, locale?: string): string {
  const gb = bytes >= 1024 ** 3;
  const value = gb ? bytes / 1024 ** 3 : bytes / 1024 ** 2;
  return new Intl.NumberFormat(locale, { style: 'unit', unit: gb ? 'gigabyte' : 'megabyte', maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

/** Settings › Bots: the space bot task folders use, and Clean up now (the
 *  task-end rules over every ended bot task; main/factory/taskFolderCleanup.ts). */
function TaskFoldersRow({ port, t, disabled }: { port: FactorySettingsPort; t: T; disabled: boolean }) {
  const [usage, setUsage] = useState<FactoryTaskFolderUsage | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'muted' | 'danger' } | null>(null);
  const readUsage = port.taskFolderUsage;
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const read = useCallback(() => {
    if (!readUsage) return;
    readUsage().then((u) => { if (live.current) setUsage(u); }, () => { if (live.current) setUsage(null); });
  }, [readUsage]);
  useEffect(() => { read(); }, [read]);
  if (!readUsage) return null;
  const clean = port.cleanTaskFolders;
  const text = usage === undefined
    ? t('settings.factory.taskFolders.reading')
    : usage === null
      ? t('settings.factory.taskFolders.unknown')
      : [
        t('settings.factory.taskFolders.usage', { size: taskFolderSize(usage.bytes, getLocale()), count: usage.folders }),
        ...(usage.dirty > 0 ? [t('settings.factory.taskFolders.kept', { count: usage.dirty })] : []),
      ].join(' · ');
  return (
    <>
      <SettingRow id="factorytaskfolders" label={t('settings.factory.taskFolders')} description={t('settings.factory.taskFoldersDesc')}>
        <div className="flex items-center gap-2">
          <span data-testid="factory-task-folders-usage" className="text-[13px] text-[var(--text-sub)] tabular-nums">{text}</span>
          {clean && (
            <Button
              size="md"
              variant="secondary"
              data-testid="factory-task-folders-clean"
              disabled={disabled || busy}
              onClick={() => {
                setBusy(true);
                setNote(null);
                void clean()
                  .then((r) => {
                    if (!live.current) return;
                    // The folders it could not remove, by path, with why (in English).
                    const notRemoved = r.ok && r.notRemoved && r.notRemoved.length > 0
                      ? ` ${t('settings.factory.taskFolders.notRemoved', { list: r.notRemoved.map((f) => `${f.path} (${f.reason})`).join('; ') })}`
                      : '';
                    setNote(r.ok
                      ? { text: t('settings.factory.taskFolders.cleaned', { removed: r.removed, kept: r.keptDirty, busy: r.busy }) + notRemoved, tone: notRemoved ? 'danger' : 'muted' }
                      : { text: t('settings.factory.taskFolders.cleanFailed', { message: r.message }), tone: 'danger' });
                  })
                  .catch((err: unknown) => { if (live.current) setNote({ text: t('settings.factory.taskFolders.cleanFailed', { message: String(err) }), tone: 'danger' }); })
                  .finally(() => {
                    if (!live.current) return;
                    setBusy(false);
                    read();
                  });
              }}
            >
              {t('settings.factory.taskFolders.clean')}
            </Button>
          )}
        </div>
      </SettingRow>
      {note && <SettingNote tone={note.tone} data-testid="factory-task-folders-note" role={note.tone === 'danger' ? 'alert' : 'status'}>{note.text}</SettingNote>}
    </>
  );
}

export interface FactoryTabProps {
  /** Tests: the ports (default: the preload's factory bridge). */
  settingsPort?: FactorySettingsPort;
  botPort?: FactoryBotPort;
  /** Tests: the folder picker for "Add bot" (default: the app's dialog). */
  pickFolder?: () => Promise<string | null>;
  /** Tests: the bots' Claude sign-in port (default: the preload's). */
  claudeAuthPort?: ClaudeAuthPort;
}

export function FactoryTab({ settingsPort, botPort, pickFolder, claudeAuthPort }: FactoryTabProps): React.ReactElement {
  const t = useT();
  const sPort = settingsPort ?? getFactorySettingsPort();
  const bPort = botPort ?? getFactoryBotPort();
  const aPort = useMemo(() => claudeAuthPort ?? bridgeClaudeAuthPort(), [claudeAuthPort]);
  const [settings, setSettings] = useState<FactorySettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorsDraft, setAuthorsDraft] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  // A bot belongs to one of the owner's workspaces: never another
  // computer's, never a bot worker's (Sidebar/botTasks.ts).
  const storeWorkspaces = useStore((s) => s.workspaces);
  const botOwners = useStore(selectBotTaskOwners);
  const workspaces = useMemo(() => withoutBotTasks(listedWorkspaces(storeWorkspaces), botOwners), [storeWorkspaces, botOwners]);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaceName = useCallback((id: string) => useStore.getState().workspaces.find((w) => w.id === id)?.name ?? id, []);
  // Names for the always-allow rules' scopes.
  const ruleBots = useFactoryBots(null, bPort);
  const botName = useCallback((id: string) => ruleBots.find((r) => r.bot.id === id)?.bot.name ?? null, [ruleBots]);

  useEffect(() => {
    let live = true;
    if (!sPort.available) return;
    sPort.get().then((s) => { if (live) setSettings(s); }, () => undefined);
    return () => { live = false; };
  }, [sPort]);

  const patch = async (p: Partial<FactorySettingsView>) => {
    setError(null);
    try {
      const next = await sPort.set(p);
      if (next) setSettings(next);
      else setError(t('settings.factory.notStarted'));
      // Off stops the bots' running work too: main says what it stopped.
      if (p.enabled === false) toastStoppedWork(next, t, useStore.getState(), botsStopPort(bPort));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if ('enabled' in p) void refreshRoomStatus();
  };
  // Turning the bots on asks the plan consent first when it is not stored.
  const consent = useBotsPlanConsent(t);
  const setEnabled = async (on: boolean) => {
    if (!on) return patch({ enabled: false });
    const p = await botsOnPatch(settings, consent.confirmOn);
    if (p) await patch(p);
  };
  // "Add bot" while the bots are off turns them on (after its confirm).
  const turnOn = async (): Promise<TurnBotsOnResult> => {
    const p = await botsOnPatch(settings, consent.confirmOn);
    if (!p) return 'declined';
    const next = await sPort.set(p);
    if (next) setSettings(next);
    void refreshRoomStatus();
    return next?.enabled ? 'on' : 'failed';
  };

  const off = !sPort.available || !settings;
  // The morning report and the phone's bot act on nothing while the bots are
  // off, so they wait for the switch. Rows that limit what bots may do (who
  // they trust, caps, the command reviewer, auto-merge) stay editable, so they
  // can be set before the bots start.
  const botsOff = settings?.enabled === false;

  return (
    <div data-testid="factory-tab" className="contents">
      {!sPort.available && (
        <SettingsSection>
          <SettingNote data-testid="factory-not-installed">{t('settings.factory.notInstalled')}</SettingNote>
        </SettingsSection>
      )}
      <SettingsSection title={t('settings.factory.section')}>
        <SettingRow id="factoryswitch" label={t('settings.factory.enabled')} description={t('settings.factory.enabledDesc')}>
          <Switch checked={settings?.enabled === true} disabled={off} onCheckedChange={(v) => void setEnabled(v)} data-testid="factory-enabled" />
        </SettingRow>
        <SettingRow id="factorytrustedauthors" label={t('settings.factory.trustedAuthors')} description={t('settings.factory.trustedAuthorsDesc')}>
          <Input
            disabled={off}
            value={authorsDraft ?? (settings?.trustedAuthors ?? []).join(', ')}
            placeholder="octocat, hubot"
            onChange={(e) => setAuthorsDraft(e.target.value)}
            onBlur={() => {
              if (authorsDraft === null) return;
              void patch({ trustedAuthors: parseAuthors(authorsDraft) });
              setAuthorsDraft(null);
            }}
            className="w-[220px] text-[13px]"
          />
        </SettingRow>
        <SettingRow id="factorymorning" label={t('settings.factory.morning')} description={t('settings.factory.morningDesc')} layout="stacked">
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              disabled={off || botsOff}
              aria-label={t('settings.factory.morningHour')}
              value={String(settings?.morning.hour ?? 9)}
              onChange={(e) => settings && void patch({ morning: { ...settings.morning, hour: Number(e.target.value) } })}
            >
              {HOURS.map((h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
            </Select>
            {WEEKDAYS.map((d) => {
              const on = settings?.morning.weekdays.includes(d) === true;
              return (
                <button
                  key={d}
                  type="button"
                  disabled={off || botsOff}
                  aria-pressed={on}
                  data-weekday={d}
                  onClick={() => settings && void patch({
                    morning: { ...settings.morning, weekdays: on ? settings.morning.weekdays.filter((x) => x !== d) : [...settings.morning.weekdays, d].sort((a, b) => a - b) },
                  })}
                  className={`h-[26px] min-w-[34px] px-1.5 rounded-[var(--chip-radius)] text-[12px] disabled:opacity-40 ${on ? 'bg-[var(--selection-emphasis)] [--text-muted:var(--text-sub)] text-[var(--text-main)]' : 'bg-[var(--selection)] text-[var(--text-sub)] hover:bg-[var(--selection-hover)] hover:[--text-muted:var(--text-subtle)]'} ${FOCUS_RING}`}
                >
                  {t(`settings.factory.weekday.${d}`)}
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow id="factoryverifierownprs" label={t('settings.factory.verifierOwnPrs')} description={t('settings.factory.verifierOwnPrsDesc')}>
          <Switch checked={settings?.verifierOnOwnerPrs === true} disabled={off} onCheckedChange={(v) => void patch({ verifierOnOwnerPrs: v })} />
        </SettingRow>
        <SettingRow id="factorycommandreviewer" label={t('bots.commands.reviewerSetting')}>
          <Switch checked={settings?.botCommandReviewer !== false} disabled={off} onCheckedChange={(v) => void patch({ botCommandReviewer: v })} data-testid="factory-command-reviewer" aria-label={t('bots.commands.reviewerSetting')} />
        </SettingRow>
        <SettingRow id="factoryengine" label={t('settings.factory.engine')} description={t('settings.factory.engineDesc')}>
          <span data-testid="factory-engine" className="text-[13px] text-[var(--text-main)]">{t('settings.factory.engineSdk')}</span>
        </SettingRow>
        <SettingRow id="factoryconcurrency" label={t('settings.factory.concurrency')} description={t('settings.factory.concurrencyDesc')}>
          <Select
            disabled={off}
            value={String(settings?.globalConcurrentBots ?? 2)}
            onChange={(e) => void patch({ globalConcurrentBots: Number(e.target.value) })}
          >
            {CONCURRENCY.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </SettingRow>
        <SettingRow id="factorymaxagents" label={t('settings.factory.maxAgents')} description={t('settings.factory.maxAgentsDesc')}>
          <Select
            disabled={off}
            data-testid="factory-max-agents"
            value={String(settings?.maxConcurrentAgents ?? 6)}
            onChange={(e) => void patch({ maxConcurrentAgents: Number(e.target.value) })}
          >
            {MAX_AGENTS.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </SettingRow>
        <SettingRow id="factorylaneautomerge" label={t('settings.factory.laneAutoMerge')} description={t('settings.factory.laneAutoMergeDesc')}>
          <Switch checked={settings?.laneAutoMerge === true} disabled={off} onCheckedChange={(v) => void patch({ laneAutoMerge: v })} data-testid="factory-lane-auto-merge" />
        </SettingRow>
        <SettingRow id="factorylanedailycap" label={t('settings.factory.laneDailyCap')} description={t('settings.factory.laneDailyCapDesc', { max: FACTORY_LANE_DAILY_CAP_MAX })}>
          <Input
            type="number"
            min={0}
            max={FACTORY_LANE_DAILY_CAP_MAX}
            data-testid="factory-lane-daily-cap"
            aria-label={t('settings.factory.laneDailyCap')}
            disabled={off}
            value={capDraft ?? String(settings?.laneDailyCap ?? 5)}
            onChange={(e) => setCapDraft(e.target.value)}
            onBlur={() => {
              if (capDraft === null) return;
              const cap = parseDailyCap(capDraft);
              if (cap !== null && cap !== settings?.laneDailyCap) void patch({ laneDailyCap: cap });
              setCapDraft(null);
            }}
            className="w-[80px] text-[13px]"
          />
        </SettingRow>
        <SettingRow id="factoryphonebot" label={t('settings.factory.phoneBot')} description={t('settings.factory.phoneBotDesc')}>
          <PhoneBotSelect t={t} disabled={off || botsOff} value={settings?.phoneBotId ?? undefined} onChange={(id) => void patch({ phoneBotId: id })} />
        </SettingRow>
        <TaskFoldersRow port={sPort} t={t} disabled={off} />
        {error && <SettingNote tone="danger" role="alert">{error}</SettingNote>}
      </SettingsSection>
      <ClaudeAuthSection t={t} mode={settings?.claudeAuth === 'apiKey' ? 'apiKey' : 'subscription'} disabled={off} onModeChange={(m) => void patch({ claudeAuth: m })} port={aPort} />
      <SettingsSection id="factorybots" title={t('settings.factory.bots')} description={t('settings.factory.botsDesc')}>
        <BotsList
          t={t}
          port={bPort}
          workspaceName={workspaceName}
          workspaces={workspaces}
          defaultWorkspaceId={activeWorkspaceId}
          pickFolder={pickFolder ?? pickFolderDialog}
          botsOff={settings?.enabled === false}
          turnOn={turnOn}
        />
      </SettingsSection>
      <BotConnectionsSection t={t} />
      <ApprovalRules t={t} botName={botName} workspaceName={workspaceName} />
      <BotSecretsSection t={t} />
      {consent.dialog}
    </div>
  );
}

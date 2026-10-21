// ─── The Bots rail page (owner decision 2026-10-13) ──────────────────────
//
// The factory's bots, as a messenger: a conversation list on the left (search
// and "+" in its header — Add bot, New group chat; each row an avatar, the
// name and a one-line preview of the newest message, a needs-you badge on a
// bot that waits on the owner) and the selected conversation as a chat on
// the right (BotsChat). The list holds each bot's 1:1 and the group chats
// the owner made (owner decision 2026-10-15: no workspace has a room by
// itself), by latest activity; nothing is pinned. A deleted bot's kept 1:1
// sits under Archive, folded, at the list's foot (owner decision
// 2026-10-21). Add team ("+" › Add team) makes the bots a workspace's team
// is missing, then offers "Make a group chat with this team". On a narrow
// sheet the list comes first and a conversation opens over it with a back
// button.
//
// The page covers the whole sheet, the room dock included: the conversation
// is the page here. Everything shown is derived from the room, bot and
// fan-out stores (botsModel.ts); the page owns no data.
//
// With no bot yet the page is one centred panel (2026-10-14, like a
// messenger's first run): "Name your first bot", a name and Start, which
// turns the bots on if they are off and adds the bot to the current
// workspace; its 1:1 opens at once, "Starting…" until its greeting arrives.
// When the Claude engine cannot sign in, the panel says why and offers
// Log in to Claude, and Start waits. "+" is always there; adding a bot while
// the bots are off turns them on after one inline confirm. With the bots off
// and some added, the page stays: the conversations and live workers
// read-only under a "Bots are off" banner with Turn bots on. The header's
// menu holds Stop all bots (an inline confirm).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { isTimelineLoaded, loadRoomActors, refreshRoomStatus, type RoomsApi } from '../../hooks/useRoomSync';
import { dmThreadId, type RoomCard, type ThreadId } from '../../../shared/room';
import { timelineKey } from '../../stores/slices/roomSlice';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import { IconMoreHorizontal, IconPlus, IconSearch } from '../icons';
import Popover from '../ui/Popover';
import { getFactoryBotPort, getFactorySettingsPort, type FactoryBotPort, type FactoryBotRow, type FactorySettingsPort } from '../Room/factoryPorts';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import Input from '../ui/Input';
import { AddBotForm, AddBotRepoRow, addBotBlockedReason, pickFolderDialog, teamNames, teamPlan, useAddBotRepo } from '../Settings/FactoryTab';
import { TEAM_TEMPLATES } from '../../../shared/botCreate';
import { PresenceDot, botPresence } from '../Room/BotChips';
import { actorLabel, formatCardTime } from '../Room/roomFormat';
import BotAvatar from '../Room/BotAvatar';
import { RoomAvatar } from './BotsAvatar';
import BotsWorkerTree, { TreeToggle } from './BotsWorkerTree';
import { BotsChat } from './BotsChat';
import { createBot, openFactorySettings, turnBotsOn } from './botsAddBot';
import { confirmBotsAlreadyOn, useBotsPlanConsent } from './BotsPlanConsent';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { selectBotTaskOwners, withoutBotTasks } from '../Sidebar/botTasks';
import { blocksStart, bridgeEnginePort, useEngineReadiness, type EnginePort } from './botsEngine'
import { CLAUDE_CODE_INSTALL_URL } from '../../../shared/factoryEngine';
import { BOT_NAME_MAX, isCoordinatorBot, normalizeBotName, type BotProfile } from '../../../shared/bot';
import { listedWorkspaces } from '../../../shared/pcRail';
import { allRoomCards, botConversationId, conversationCards, groupConversationId, groupViewCards, roomCardsByWorkspace, type Conversation } from './botsModel';
import BotsGroupDialog, { type GroupDialogStart } from './BotsGroupDialog';
import { getBotGroupPort, type BotGroupPort } from '../Room/botGroups';
import type { BotGroup } from '../../../shared/botGroup';
import { unreadCount } from './botsTimeline';
import { BOTS_SESSION_START } from '../../stores/slices/roomSlice';
import { loadWholeThread, useBots, useBotsSync } from './useBots';
import { botsStopPort, stopAllSummary, toastStoppedWork, type BotsStopPort } from './botsStop';
import { InlineConfirm } from './InlineConfirm';
import GuestBotsDialog, { type GuestConversationOption } from './GuestBotsDialog';
import { getGuestBotPort, type GuestBotPort } from './guestBots';
import './bots.css';

type T = ReturnType<typeof useT>;

/** The conversation shown last, kept while the app runs (leaving the page
 *  and coming back opens it again). */
let lastSelected: string | null = null;

/** A conversation's name: the bot's own, or the group's (a group made from
 *  a workspace's room: the workspace's). */
export function conversationTitle(c: Conversation, workspaceName: (id: string) => string | null): string {
  if (c.kind === 'bot') return c.row.bot.name;
  return c.group.name || (workspaceName(c.workspaceId) ?? c.workspaceId);
}

/** The card a row's preview and time show: the newest message, or a bot's
 *  newer post in a group chat. Pure. */
export function previewCard(c: Conversation): RoomCard | null {
  if (c.kind === 'bot' && c.elsewhere) return c.elsewhere.card;
  return c.last;
}

/** The row's one-line preview of the newest message: for a bot whose
 *  newest post is in a group chat, that post, prefixed with the group's
 *  name. Pure. */
export function conversationPreview(
  c: Conversation,
  t: (key: string, vars?: Record<string, string | number>) => string,
  bots: readonly FactoryBotRow[],
  actors: Readonly<Record<string, { role: FactoryBotRow['bot']['role'] }>> = {},
  titleOf: (conversationId: string) => string | null = () => null,
): string {
  if (c.kind === 'bot' && c.elsewhere) {
    const group = titleOf(c.elsewhere.conversationId);
    return group ? t('botsPage.inGroup', { group, text: c.elsewhere.card.title }) : c.elsewhere.card.title;
  }
  const last: RoomCard | null = c.last;
  if (!last) return t('botsPage.noMessages');
  if (last.actor.kind === 'human') return t('botsPage.you', { text: last.title });
  if (c.kind === 'room' && last.actor.kind === 'bot') return `${actorLabel(last.actor, t, bots, actors)}: ${last.title}`;
  return last.title;
}

/** A bot just added is "starting" until its first message arrives (its
 *  greeting), unless its turn failed. Pure. */
export function isStillStarting(c: Conversation | undefined): boolean {
  if (!c) return true;
  return c.kind === 'bot' && c.last === null && !c.row.status?.lastError;
}

/** After this long a new bot's chat opens even without its greeting. */
const STARTING_MAX_MS = 120_000;

function NeedsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span data-bots-needs={count} aria-hidden="true" className="wmux-bots-badge">{count > 99 ? '99+' : count}</span>;
}

/** A conversation's unread messages: a neutral count, shown only when
 *  nothing there needs the owner (the orange count wins). */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span data-bots-unread={count} aria-hidden="true" className="wmux-bots-unread">{count > 99 ? '99+' : count}</span>;
}

function ConversationRow({ c, title, preview, selected, t, onSelect, now, unread = 0, toggleRoom = false }: {
  c: Conversation; title: string; preview: string; selected: boolean; t: T; onSelect: () => void; now?: number;
  /** The workers' fold toggle sits at the end of the preview line. */
  toggleRoom?: boolean;
  /** Bot messages after the conversation was last read (this session). */
  unread?: number;
}) {
  const needsText = c.needsYou > 0 ? t('sidebar.fleetNeedsYou', { count: c.needsYou }) : '';
  const unreadText = c.needsYou <= 0 && unread > 0 ? t('botsPage.chat.unread', { count: unread }) : '';
  const name = [title, needsText, unreadText, preview].filter(Boolean).join(', ');
  const shownAt = previewCard(c)?.at ?? null;
  // A deleted bot's 1:1: read-only, its name muted, no presence.
  const removed = c.kind === 'bot' && c.removed === true;
  return (
    <button
      type="button"
      data-bots-row={c.id}
      data-bots-kind={c.kind}
      data-bots-removed={removed ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={name}
      onClick={onSelect}
      className={`wmux-bots-row-button ${selected ? 'is-selected' : ''} ${FOCUS_RING}`}
    >
      <span className="relative shrink-0">
        {c.kind === 'bot' ? <BotAvatar bot={c.row.bot} size={32} working={botPresence(c.row) === 'running'} /> : <RoomAvatar bots={c.bots} size={32} />}
        {c.kind === 'bot' && !removed && (
          <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-[var(--bg-mantle)] p-[2px]"><PresenceDot presence={botPresence(c.row)} /></span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={`min-w-0 truncate text-[13px] font-[var(--title-weight,500)] ${removed ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}>{title}</span>
          {shownAt !== null && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{formatCardTime(shownAt, now)}</span>}
        </span>
        <span className={`flex items-center gap-1.5 ${toggleRoom ? 'pr-[34px]' : ''}`}>
          <span className={`min-w-0 flex-1 truncate text-[12px] ${unread > 0 ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)]'}`}>{preview}</span>
          <NeedsBadge count={c.needsYou} />
          {c.needsYou <= 0 && <UnreadBadge count={unread} />}
        </span>
      </span>
    </button>
  );
}

/** The bots-off banner: the page is read-only until Turn bots on turns the
 *  bots back on (the factory setting, as Settings writes it). */
function PausedBanner({ t, settings, confirmOn }: { t: T; settings: FactorySettingsPort; confirmOn: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if ((await turnBotsOn(settings, confirmOn)) === 'failed') setError(t('settings.factory.notStarted'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wmux-bots-banner" data-bots-paused role="status">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.paused')}</div>
        <div className="truncate text-[12px] text-[var(--text-muted)]">{error ?? t('botsPage.pausedDetail')}</div>
      </div>
      {settings.available ? (
        <Button size="sm" variant={busy ? 'secondary' : 'primary'} data-bots-run disabled={busy} onClick={() => void run()}>{t('botsPage.runBots')}</Button>
      ) : (
        <Button size="sm" variant="secondary" data-bots-open-settings onClick={openFactorySettings}>{t('botsPage.openSettings')}</Button>
      )}
    </div>
  );
}

/** The engine's state as the first screen's one line, or null when it does
 *  not hold Start back. */
function engineLine(r: ReturnType<typeof useEngineReadiness>['readiness'], t: T): string | null {
  if (!blocksStart(r)) return null;
  if (r?.reason === 'claude-not-installed') return t('botsPage.onboarding.notInstalled');
  if (r?.reason === 'claude-unusable') return t('botsPage.onboarding.unusable');
  return t('botsPage.onboarding.notLoggedIn');
}

function openClaudeInstallPage(): void {
  void window.electronAPI?.shell?.openExternal?.(CLAUDE_CODE_INSTALL_URL)?.catch?.(() => undefined);
}

/** The first screen, with no bot yet: name a bot and Start (DESIGN.md ›
 *  Bots › First run). The page is reached with the bots on; Start adds the
 *  bot to the current workspace (turning the bots on first only if they went
 *  off meanwhile). */
function FirstBotPanel({ t, workspace, botPort, settings, confirmOn, on, engine, onStarted, onTeam, onRecipe, rows = [] }: {
  t: T;
  workspace: { id: string; name: string } | null;
  botPort: FactoryBotPort;
  /** The bots main lists (none enabled here): Add team names around them. */
  rows?: readonly FactoryBotRow[];
  settings: FactorySettingsPort;
  /** The plan consent, asked when turning the bots on needs it. */
  confirmOn: () => Promise<boolean>;
  on: boolean;
  engine: EnginePort;
  onStarted: (bot: BotProfile) => void;
  /** A team was added: the page offers a group chat with it. */
  onTeam: (team: readonly BotProfile[]) => void;
  /** Opens the full Add bot form, where a recipe is picked. */
  onRecipe: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { readiness, checking, recheck, login } = useEngineReadiness(engine);
  const repo = useAddBotRepo(botPort, [], workspace?.id ?? '', pickFolderDialog);
  const typed = normalizeBotName(name);
  const blocked = addBotBlockedReason({ canCreate: !!botPort.create, workspaceId: workspace?.id ?? '', name, jobOk: true });
  const engineText = engineLine(readiness, t);
  const canLogin = !!engineText && readiness?.reason === 'claude-not-logged-in' && !!engine.login;
  // Start waits for the engine's first answer (a build that cannot ask never waits).
  const engineUnanswered = !!engine.readiness && readiness === null;
  const startable = !busy && !blocked && !engineText && !engineUnanswered;
  // Add a team: the five team bots here at once, with no name to type; the
  // same readiness as Start, and its lead's chat opens.
  const teamable = !busy && !!workspace && !!botPort.createTeam && !engineText && !engineUnanswered;
  const names = teamNames(t);
  const plan = teamPlan(rows, workspace?.id ?? '', t);

  const start = async () => {
    if (!startable || !typed || !workspace) return;
    setBusy(true);
    setError(null);
    try {
      if (!on) {
        const r = await turnBotsOn(settings, confirmOn);
        if (r === 'declined') return;
        if (r !== 'on') { setError(t('settings.factory.notStarted')); return; }
      }
      const r = await createBot(botPort, { workspaceId: workspace.id, name: typed, ...(repo.repoFolder ? { repoFolder: repo.repoFolder } : {}) });
      if (r.ok) onStarted(r.bot);
      else setError(r.message || t('settings.factory.addBotFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const startTeam = async () => {
    if (!teamable || !workspace || !botPort.createTeam) return;
    setBusy(true);
    setError(null);
    try {
      if (!on) {
        const r = await turnBotsOn(settings, confirmOn);
        if (r === 'declined') return;
        if (r !== 'on') { setError(t('settings.factory.notStarted')); return; }
      }
      const r = await botPort.createTeam({ workspaceId: workspace.id, names: plan.names, ...(repo.repoFolder ? { repoFolder: repo.repoFolder } : {}) });
      if (!r.ok) setError(r.message || t('settings.factory.addTeamFailed'));
      else if (r.bots.length === 0) setError(t('settings.factory.addTeamWhole'));
      else {
        onTeam(r.bots);
        // Only a lead made here greets: its chat opens, starting.
        const lead = r.bots.find((b) => isCoordinatorBot(b));
        if (lead) onStarted(lead);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // main opens the sign-in in a terminal tab of the current workspace: the
  // page steps aside to it and asks again when the owner comes back.
  const loginNow = async () => {
    setError(null);
    try {
      await login();
      const st = useStore.getState();
      st.pushToast({ message: t('botsPage.onboarding.loginOpened'), level: 'info' });
      showWorkspaces(st);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const shownError = error ?? repo.error;

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8" data-bots-first-run>
      <div className="flex w-full max-w-[440px] flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--bg-base)] p-6">
        <div>
          <h1 className="text-[16px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.onboarding.title')}</h1>
          <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
            {workspace ? t('botsPage.onboarding.detail', { workspace: workspace.name }) : t('botsPage.onboarding.detailAny')}
          </p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void start(); }}
        >
          <Input
            data-bots-first-name
            autoFocus
            value={name}
            maxLength={BOT_NAME_MAX}
            aria-label={t('botsPage.onboarding.title')}
            placeholder={t('settings.factory.addBotNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 text-[13px]"
          />
          <Button type="submit" size="sm" variant={startable ? 'primary' : 'secondary'} data-bots-first-start disabled={!startable}>
            {t('botsPage.onboarding.start')}
          </Button>
          {botPort.createTeam && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-bots-first-team
              disabled={!teamable}
              title={t('settings.factory.addTeamHint', { names: TEAM_TEMPLATES.map((tpl) => names[tpl]).join(', '), lead: names.coordinator })}
              onClick={() => void startTeam()}
            >
              {t('botsPage.onboarding.addTeam')}
            </Button>
          )}
        </form>
        {workspace && (
          <AddBotRepoRow view={repo.view} t={t} busy={busy} onChoose={() => void repo.choose()} onNone={repo.chooseNone} />
        )}
        {workspace && (
          <button
            type="button"
            data-bots-first-recipe
            disabled={busy}
            onClick={onRecipe}
            className={`self-start text-[12px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          >
            {t('botsPage.onboarding.fromRecipe')}
          </button>
        )}
        {blocked && name.trim() !== '' && <p data-bots-first-blocked className="text-[11px] text-[var(--text-muted)]">{t(blocked, { max: BOT_NAME_MAX })}</p>}
        {!workspace && <p data-bots-first-blocked className="text-[11px] text-[var(--text-muted)]">{t('settings.factory.addBotNeedWorkspace')}</p>}
        {engineText && (
          <div data-bots-engine={readiness?.reason} role="status" className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[var(--selection-subtle)] px-3 py-2">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--text-sub)]">{engineText}</p>
            {readiness?.reason === 'claude-not-installed' && (
              <Button size="sm" variant="primary" data-bots-engine-install onClick={openClaudeInstallPage}>{t('botsPage.onboarding.install')}</Button>
            )}
            {canLogin && (
              <Button size="sm" variant="primary" data-bots-engine-login onClick={() => void loginNow()}>{t('botsPage.onboarding.login')}</Button>
            )}
            <Button size="sm" variant="ghost" data-bots-engine-recheck disabled={checking} onClick={recheck}>{t('botsPage.onboarding.checkAgain')}</Button>
          </div>
        )}
        {shownError && <p role="alert" data-bots-first-error className="text-[12px] text-[var(--accent-red)]">{shownError}</p>}
      </div>
    </div>
  );
}

/** A bot just added, before its greeting: its chat's place, saying so. */
function StartingChat({ bot, t, onBack }: { bot: BotProfile; t: T; onBack: () => void }) {
  return (
    <section className="wmux-bots-chat" data-bots-chat={botConversationId(bot.id)} data-bots-starting aria-label={bot.name}>
      <div className="wmux-bots-chat-head">
        <button type="button" data-bots-back onClick={onBack} aria-label={t('botsPage.back')} title={t('botsPage.back')} className={`wmux-bots-back ${FOCUS_RING}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9,2.5 4.5,7 9,11.5" /></svg>
        </button>
      </div>
      <div role="status" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <BotAvatar bot={bot} size={48} />
        <div className="text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.add.starting', { name: bot.name })}</div>
        <p className="text-[12px] text-[var(--text-muted)]">{t('botsPage.add.startingDetail')}</p>
      </div>
    </section>
  );
}

/** The list header's menu: Stop all bots (only when main offers it). */
function HeaderMenu({ t, onStopAll, onGuests }: { t: T; onStopAll: (() => void) | null; onGuests: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-bots-menu
        aria-label={t('botsPage.menu')}
        title={t('botsPage.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`wmux-bots-icon-button ${open ? 'is-open' : ''} ${FOCUS_RING}`}
      >
        <IconMoreHorizontal size={16} />
      </button>
      {open && (
        <Popover
          role="menu"
          aria-label={t('botsPage.menu')}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px]"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          {onGuests && (
            <button
              type="button"
              role="menuitem"
              data-bots-guests
              autoFocus
              onClick={() => { setOpen(false); onGuests(); }}
              className={`ui-section-row w-full text-left text-[13px] text-[var(--text-main)] ${FOCUS_RING}`}
            >
              {t('botsPage.guest.menu')}
            </button>
          )}
          {onStopAll && (
            <button
              type="button"
              role="menuitem"
              data-bots-stop-all
              autoFocus={!onGuests}
              onClick={() => { setOpen(false); onStopAll(); }}
              className={`ui-section-row w-full text-left text-[13px] text-[var(--accent-red)] ${FOCUS_RING}`}
            >
              {t('botsPage.stop.all')}
            </button>
          )}
        </Popover>
      )}
    </span>
  );
}

/** "+": Add bot, Add team or New group chat. */
function AddMenu({ t, onAddBot, onAddTeam, onNewGroup }: { t: T; onAddBot: () => void; onAddTeam: (() => void) | null; onNewGroup: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const item = `ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`;
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-bots-add
        aria-label={t('botsPage.add.menu')}
        title={t('botsPage.add.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`wmux-bots-icon-button ${open ? 'is-open' : ''} ${FOCUS_RING}`}
      >
        <IconPlus size={16} />
      </button>
      {open && (
        <Popover
          role="menu"
          aria-label={t('botsPage.add.menu')}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px]"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          <button type="button" role="menuitem" data-bots-add-bot autoFocus className={item} onClick={() => { setOpen(false); onAddBot(); }}>
            {t('botsPage.addBot')}
          </button>
          {onAddTeam && (
            <button type="button" role="menuitem" data-bots-add-team className={item} onClick={() => { setOpen(false); onAddTeam(); }}>
              {t('settings.factory.addTeam')}
            </button>
          )}
          {onNewGroup && (
            <button type="button" role="menuitem" data-bots-new-group className={item} onClick={() => { setOpen(false); onNewGroup(); }}>
              {t('botsPage.group.new')}
            </button>
          )}
        </Popover>
      )}
    </span>
  );
}

/** The list's foot: Archive, the deleted bots' kept 1:1s, folded until
 *  toggled (or one of them is open). */
function ArchiveToggle({ t, count, expanded, onToggle }: { t: T; count: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-bots-archive-toggle
      aria-expanded={expanded}
      aria-controls="bots-archive"
      onClick={onToggle}
      className={`wmux-bots-archive-toggle ${FOCUS_RING}`}
    >
      <span className="min-w-0 flex-1 truncate text-left">{t('botsPage.archive.title')}</span>
      <span className="tabular-nums">{count}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: expanded ? 'rotate(180deg)' : undefined }}><polyline points="2,3.5 5,6.5 8,3.5" /></svg>
    </button>
  );
}

/** Split the list's rows: the live conversations, and the Archive (each
 *  deleted bot's kept 1:1). Pure. */
export function splitArchive<R extends { c: Conversation }>(rows: readonly R[]): { live: R[]; archived: R[] } {
  const live: R[] = [];
  const archived: R[] = [];
  for (const r of rows) (r.c.kind === 'bot' && r.c.removed ? archived : live).push(r);
  return { live, archived };
}

/** After Add team: one line under the list header offering a group chat
 *  with the team (the bots alone make no room), until used or dismissed. */
function TeamNotice({ t, workspace, onMake, onDismiss }: { t: T; workspace: string; onMake: () => void; onDismiss: () => void }) {
  return (
    <div data-bots-team-notice role="status" className="mx-3 mb-2 flex flex-col items-start gap-2 rounded-[10px] bg-[var(--selection-subtle)] px-3 py-2">
      {/* The list column is narrow: the line and × share the first row and
          the action takes its own, so neither squeezes the text. */}
      <div className="flex w-full items-center gap-2">
        <p data-bots-team-text className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--text-sub)]">{t('botsPage.group.teamAdded', { workspace })}</p>
        <button type="button" data-bots-team-dismiss aria-label={t('settings.close')} title={t('settings.close')} onClick={onDismiss} className={`wmux-bots-icon-button shrink-0 ${FOCUS_RING}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" /></svg>
        </button>
      </div>
      <Button size="sm" variant="secondary" className="max-w-full shrink-0 whitespace-normal text-left" data-bots-team-group onClick={onMake}>{t('botsPage.group.fromTeam')}</Button>
    </div>
  );
}

export default function BotsPage({ onAddBot, port, api, now, settings, stop, engine, groupPort, guestPort }: {
  /** What "+" does instead of the in-page add form (tests). */
  onAddBot?: () => void;
  /** Tests: the bot port and the rooms bridge. */
  port?: FactoryBotPort;
  api?: RoomsApi | null;
  now?: number;
  /** Tests: the factory settings port (Turn bots on) and the stop verbs. */
  settings?: FactorySettingsPort;
  stop?: BotsStopPort;
  /** Tests: the engine's readiness and login (default: the preload's). */
  engine?: EnginePort;
  /** Tests: the group chats port (default: the preload's). */
  groupPort?: BotGroupPort;
  /** Tests: the guest bots port (default: the preload's). */
  guestPort?: GuestBotPort;
} = {}): React.ReactElement {
  const t = useT();
  const guestsPort = guestPort ?? getGuestBotPort();
  const [guestsOpen, setGuestsOpen] = useState(false);
  const groupsPort = groupPort ?? getBotGroupPort();
  const botsState = useBots(port, groupsPort);
  useBotsSync(botsState, { focus: false, paused: true });
  // The factory may have been switched on since the status was read (in
  // Settings): opening the page asks again.
  useEffect(() => { void refreshRoomStatus(); }, []);
  const { model, status, bots, on, listed } = botsState;
  // The page is there only while the bots are on: turned off (here or in
  // Settings), it leaves for Workspaces, as its rail item goes.
  const known = !!status;
  useEffect(() => {
    if (known && !on) showWorkspaces(useStore.getState());
  }, [known, on]);
  const names = useStore(useShallow(selectWorkspaceIdName));
  const actors = useStore((s) => s.roomActors);
  const timelines = useStore((s) => s.roomTimelines);
  const cardsByWs = useMemo(() => roomCardsByWorkspace(timelines), [timelines]);
  // A 1:1 reads every room (a message to a bot may be posted in any of them).
  const everyCard = useMemo(() => allRoomCards(cardsByWs), [cardsByWs]);
  const nameOf = useMemo(() => {
    const byId = new Map(names.map((w) => [w.id, w.name]));
    return (id: string) => byId.get(id) ?? null;
  }, [names]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => lastSelected);
  // Narrow sheets show one column: the list, or the chat with a back button.
  const [view, setView] = useState<'list' | 'chat'>('list');

  const seenAt = useStore((s) => s.botsSeenAt);
  const roomThreads = useStore((s) => s.roomThreads);
  // `t` is one stable function whatever the language: the rows' previews
  // are worded again when the language changes.
  const locale = useStore((s) => s.locale);
  const rows = useMemo(() => model.conversations.map((c) => {
    const since = seenAt[c.id] ?? BOTS_SESSION_START;
    const titleOf = (id: string) => {
      const other = model.conversations.find((x) => x.id === id);
      return other ? conversationTitle(other, nameOf) : null;
    };
    const own = c.kind === 'bot' ? conversationCards(everyCard, c.row.bot.id, { lone: c.lone, threads: roomThreads }) : groupViewCards(cardsByWs.get(c.workspaceId) ?? [], c.group, roomThreads);
    return {
      c,
      title: c.kind === 'bot' && c.removed ? t('room.actor.removed', { name: c.row.bot.name }) : conversationTitle(c, nameOf),
      preview: conversationPreview(c, t, bots, actors, titleOf),
      unread: unreadCount(own, since),
    };
  }), [model.conversations, nameOf, t, locale, bots, actors, seenAt, everyCard, cardsByWs, roomThreads]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)) : rows;
  const { live: shownLive, archived: shownArchived } = splitArchive(shown);
  // Archive's fold: folded until toggled, and open while searching or while
  // one of its chats is open (DESIGN.md › Bots › Archive), toggled or not.
  const [archiveOpen, setArchiveOpen] = useState(false);

  const [threadAsk, setThreadAsk] = useState<{ conversationId: string; workspaceId: string; threadId: ThreadId; nonce: number } | null>(null);
  const select = (id: string) => {
    setSelectedId(id);
    setView('chat');
    // A thread a bot row asked to open is opened once, never on a later visit.
    setThreadAsk(null);
  };
  // A bot row whose waiting cards are all in a group chat leads there, with
  // the newest one's thread beside the group's chat (its own thread is the
  // chat itself): the needs-you count on the row is answered where it is.
  const openRow = (c: Conversation) => {
    const at = c.kind === 'bot' && c.needsYou > 0 ? c.needsAt : undefined;
    const group = at ? model.conversations.find((x) => x.id === at.conversationId) : undefined;
    if (!at || group?.kind !== 'room') {
      select(c.id);
      return;
    }
    select(group.id);
    setThreadAsk(at.threadId !== group.threadId ? { ...at, nonce: Date.now() } : null);
  };

  // Each bot's workers nest under its row (BotsWorkerTree): open under the
  // bot whose chat is open, folded under the others, until the owner toggles
  // them. A click shows the worker's terminal beside that bot's chat; the
  // panel never opens on its own.
  const [unfolded, setUnfolded] = useState<Readonly<Record<string, boolean>>>({});
  const panel = useStore((s) => s.botsWorkerPanel);
  // A worker shown from elsewhere (a notification's jump while this page is
  // up) brings its bot's chat forward, where the panel lives — each time it
  // is asked, the narrow layout's list included.
  const shownPanel = useRef(panel);
  useEffect(() => {
    if (panel && panel !== shownPanel.current) select(panel.conversationId);
    shownPanel.current = panel;
    // `select` is a fresh closure each render; only a new panel request matters.
  }, [panel]);
  const openWorker = (botId: string, workspaceId: string) => {
    const conversationId = botConversationId(botId);
    select(conversationId);
    useStore.getState().setBotsWorkerPanel({ workspaceId, conversationId });
  };

  // A bot just added (here or by the first screen) is selected at once; its
  // chat says "Starting…" until its greeting arrives (isStillStarting).
  const [pending, setPending] = useState<{ bot: BotProfile; at: number } | null>(null);
  const pendingId = pending ? botConversationId(pending.bot.id) : null;
  const pendingRow = pendingId ? rows.find((r) => r.c.id === pendingId) : undefined;
  const pendingStarting = !!pending && isStillStarting(pendingRow?.c);
  useEffect(() => {
    if (pending && !pendingStarting) setPending(null);
  }, [pending, pendingStarting]);
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setTimeout(() => setPending(null), Math.max(0, pending.at + STARTING_MAX_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pending]);
  const started = (bot: BotProfile) => {
    setPending({ bot, at: Date.now() });
    select(botConversationId(bot.id));
  };
  const starting = pending && pendingStarting && selectedId === pendingId ? pending.bot : null;
  const selected = starting ? null : rows.find((r) => r.c.id === selectedId) ?? rows[0] ?? null;

  // A deleted bot's 1:1 is read whole when opened: its messages may be
  // older than the room's newest page.
  const removedOpen = selected?.c.kind === 'bot' && selected.c.removed ? selected.c.row.bot : null;
  useEffect(() => {
    if (!removedOpen || isTimelineLoaded(useStore.getState().roomTimelines[timelineKey(removedOpen.workspaceId, dmThreadId(removedOpen.id))])) return;
    const reads = new AbortController();
    void loadWholeThread(removedOpen.workspaceId, dmThreadId(removedOpen.id), reads.signal);
    return () => reads.abort();
  }, [removedOpen?.id, removedOpen?.workspaceId]);

  const selectedKey = starting ? pendingId : selected?.c.id ?? null;
  useEffect(() => {
    if (selectedKey) lastSelected = selectedKey;
  }, [selectedKey]);

  // "+": the Settings add form in a dialog here (a build without the create
  // port opens the settings page instead). The bot it adds is selected.
  const [adding, setAdding] = useState<false | 'bot' | 'team'>(false);
  // A bot belongs to one of the owner's workspaces: never a bot worker's or
  // another computer's (the sidebar's own list).
  const botOwners = useStore(selectBotTaskOwners);
  const addWorkspaces = useMemo(() => withoutBotTasks(listedWorkspaces(names), botOwners), [names, botOwners]);
  const botPort = port ?? getFactoryBotPort();
  const canCreate = !!botPort.create;
  // The workspace a new bot goes to by default: the selected conversation's,
  // else (the first bot) the current workspace when it is one of the
  // owner's, else the first of them.
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const currentWorkspace = addWorkspaces.find((w) => w.id === activeWorkspaceId) ?? addWorkspaces[0] ?? null;
  const [addTo, setAddTo] = useState<string | null>(null);
  const openAdd = (workspaceId: string | null, mode: 'bot' | 'team' = 'bot') => {
    setAddTo(workspaceId);
    setAdding(mode);
  };
  const startAdd = onAddBot ?? (canCreate ? () => openAdd(selected?.c.workspaceId ?? null) : openFactorySettings);
  // "+" › Add team: the same form with only the workspace and repository.
  const startTeam = botPort.createTeam && !onAddBot ? () => openAdd(selected?.c.workspaceId ?? null, 'team') : null;
  // Stop all: the header menu, then an inline confirm under the header.
  const stopPort = useMemo(() => stop ?? botsStopPort(port), [stop, port]);
  const settingsPort = settings ?? getFactorySettingsPort();
  // Turning the bots on asks the plan consent; bots already on from before
  // it are asked once as the page opens (Keep bots on / Turn bots off).
  const consent = useBotsPlanConsent(t);
  const { ask: askConsent, confirmOn } = consent;
  useEffect(() => {
    void confirmBotsAlreadyOn(settingsPort, askConsent, (r) => toastStoppedWork(r, t, useStore.getState(), stopPort)).catch(() => undefined);
    // Asked once per opening: a new language or stop port must not ask again.
  }, [settingsPort, askConsent]);
  const enginePort = useMemo(() => engine ?? bridgeEnginePort(), [engine]);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopAll = async () => {
    if (!stopPort.stopAll) return;
    setStopping(true);
    try {
      const r = await stopPort.stopAll();
      useStore.getState().pushToast({ message: stopAllSummary(r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) setConfirmStopAll(false);
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setStopping(false);
    }
  };
  // Group chats: New group chat ("+"), a group's settings (its pill), and
  // the one action Add team leaves under the header.
  const [groupDialog, setGroupDialog] = useState<GroupDialogStart | null>(null);
  const [teamMade, setTeamMade] = useState<{ workspaceId: string; botIds: string[] } | null>(null);
  const onTeam = (team: readonly BotProfile[]) => {
    if (team.length >= 2) setTeamMade({ workspaceId: team[0].workspaceId, botIds: team.map((b) => b.id) });
  };
  const newGroup = groupsPort.available
    ? () => setGroupDialog({ kind: 'new', workspaceId: selected?.c.workspaceId ?? currentWorkspace?.id ?? null })
    : null;
  const shownGroup = selected?.c.kind === 'room' ? selected.c.group : null;
  const groupDone = (group: BotGroup | null) => {
    setGroupDialog(null);
    if (group) {
      setTeamMade(null);
      select(groupConversationId(group.id));
    }
  };
  const finishAdd = (bot?: BotProfile, team?: readonly BotProfile[]) => {
    setAdding(false);
    if (team) onTeam(team);
    if (bot) started(bot);
    // A team whose lead was there already: no one greets; its lead opens.
    else if (team && team.length > 0) select(botConversationId(team[0].id));
  };

  // Archive › Remove: the deleted bot's 1:1 leaves the list for good (its
  // messages stay in the room, and its name on what it wrote elsewhere).
  const clearArchived = (botId: string) => async (): Promise<string | null> => {
    if (!botPort.clearRemoved) return null;
    const r = await botPort.clearRemoved(botId);
    if (!r.ok) return r.message;
    await loadRoomActors();
    return null;
  };

  let body: React.ReactNode = null;
  // No bot yet (the list read): the first screen.
  // A deleted bot's kept 1:1 still lists.
  const firstRun = !!status && listed && bots.length === 0 && !model.conversations.some((c) => c.kind === 'bot' && c.removed) && !pending && canCreate && !onAddBot;
  if (firstRun) {
    body = (
      <FirstBotPanel
        t={t}
        workspace={currentWorkspace}
        botPort={botPort}
        settings={settingsPort}
        confirmOn={confirmOn}
        on={on}
        engine={enginePort}
        onStarted={started}
        onTeam={onTeam}
        onRecipe={() => openAdd(currentWorkspace?.id ?? null)}
        rows={bots}
      />
    );
  } else if (status && (listed || bots.length > 0 || !!pending)) {
    // (Before the bot list is read, nothing: an empty list is not "no bot".)
    const paused = !on;
    const archiveShown = archiveOpen || !!q || shownArchived.some((a) => a.c.id === selected?.c.id);
    const renderEntry = (r: (typeof rows)[number]) => {
      const tree = r.c.kind === 'bot' ? r.c.tree : [];
      const botId = r.c.kind === 'bot' ? r.c.row.bot.id : '';
      const isSelected = selected?.c.id === r.c.id || (!!starting && r.c.id === pendingId);
      const open = tree.length > 0 && (unfolded[r.c.id] ?? isSelected);
      const treeId = `bots-tree-${r.c.id}`;
      // The open conversation is one group: its row and its workers in
      // one rounded fill, as the Sidebar draws the selected workspace
      // and its tasks.
      return (
        <div key={r.c.id} data-bots-entry={r.c.id} className={`wmux-bots-entry ${isSelected ? 'is-open' : ''}`}>
          <div className={`wmux-bots-row-wrap ${tree.length > 0 ? 'has-toggle' : ''}`}>
            <ConversationRow
              c={r.c}
              title={r.title}
              preview={r.preview}
              selected={isSelected}
              t={t}
              now={now}
              unread={r.unread}
              onSelect={() => openRow(r.c)}
              toggleRoom={tree.length > 0}
            />
            {tree.length > 0 && (
              <TreeToggle
                count={tree.length}
                expanded={open}
                controls={treeId}
                name={r.title}
                t={t}
                onToggle={() => setUnfolded((cur) => ({ ...cur, [r.c.id]: !open }))}
              />
            )}
          </div>
          {open && (
            <BotsWorkerTree
              id={treeId}
              rows={tree}
              name={r.title}
              shownId={isSelected && panel?.conversationId === r.c.id ? panel.workspaceId : null}
              t={t}
              onOpen={(workspaceId) => openWorker(botId, workspaceId)}
            />
          )}
        </div>
      );
    };
    body = (
      <>
        {paused && <PausedBanner t={t} settings={settingsPort} confirmOn={confirmOn} />}
        <div className="wmux-bots-body">
        <nav className="wmux-bots-list" aria-label={t('botsPage.conversations')}>
          <div className="wmux-bots-list-head">
            <h1 className="min-w-0 flex-1 truncate text-[16px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.title')}</h1>
            <button
              type="button"
              data-bots-search-toggle
              aria-label={t('botsPage.search')}
              title={t('botsPage.search')}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((v) => !v);
                if (!searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
                else setQuery('');
              }}
              className={`wmux-bots-icon-button ${searchOpen ? 'is-open' : ''} ${FOCUS_RING}`}
            >
              <IconSearch size={16} />
            </button>
            {(stopPort.stopAll || guestsPort.available) && (
              <HeaderMenu
                t={t}
                onStopAll={stopPort.stopAll ? () => setConfirmStopAll(true) : null}
                onGuests={guestsPort.available ? () => setGuestsOpen(true) : null}
              />
            )}
            <AddMenu t={t} onAddBot={startAdd} onAddTeam={startTeam} onNewGroup={newGroup} />
          </div>
          {teamMade && newGroup && (
            <TeamNotice
              t={t}
              workspace={nameOf(teamMade.workspaceId) ?? teamMade.workspaceId}
              onMake={() => setGroupDialog({ kind: 'new', workspaceId: teamMade.workspaceId, name: nameOf(teamMade.workspaceId) ?? '', memberIds: teamMade.botIds })}
              onDismiss={() => setTeamMade(null)}
            />
          )}
          {confirmStopAll && (
            <div className="px-4 pb-3">
              <InlineConfirm
                text={t('botsPage.stop.allConfirm')}
                confirmLabel={t('botsPage.stop.allAction')}
                cancelLabel={t('room.hq.cancel')}
                busy={stopping}
                onConfirm={() => void stopAll()}
                onCancel={() => setConfirmStopAll(false)}
                testId="bots-stop-all"
              />
            </div>
          )}
          {searchOpen && (
            <div className="px-3 pb-2">
              <input
                ref={searchRef}
                type="search"
                value={query}
                data-bots-search
                aria-label={t('botsPage.search')}
                placeholder={t('botsPage.search')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setQuery('');
                    setSearchOpen(false);
                  }
                }}
                className={`h-[28px] w-full rounded-[6px] border border-[var(--line)] bg-transparent px-2 text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] ${FOCUS_RING}`}
              />
            </div>
          )}
          <div className="wmux-bots-rows">
            {shown.length === 0 && rows.length > 0 && <p className="px-4 py-3 text-[12px] text-[var(--text-muted)]">{t('botsPage.noMatch')}</p>}
            {rows.length === 0 && !starting && <p data-bots-empty className="px-4 py-3 text-[12px] text-[var(--text-muted)]">{t('botsPage.noConversations')}</p>}
            {shownLive.map(renderEntry)}
            {shownArchived.length > 0 && (
              <>
                <ArchiveToggle t={t} count={shownArchived.length} expanded={archiveShown} onToggle={() => setArchiveOpen((v) => !v)} />
                {archiveShown && <div id="bots-archive" data-bots-archive>{shownArchived.map(renderEntry)}</div>}
              </>
            )}
          </div>
        </nav>
        {starting ? (
          <StartingChat bot={starting} t={t} onBack={() => setView('list')} />
        ) : selected ? (
          <BotsChat
            key={selected.c.id}
            conversation={selected.c}
            roomCards={selected.c.kind === 'bot' ? everyCard : cardsByWs.get(selected.c.workspaceId) ?? []}
            bots={bots}
            title={selected.title}
            workspaceName={nameOf(selected.c.workspaceId) ?? selected.c.workspaceId}
            t={t}
            api={api}
            now={now}
            onBack={() => setView('list')}
            readOnly={paused}
            stopPort={stopPort}
            jobPort={botPort}
            resumePort={botPort}
            onOpenBot={(botId) => select(botConversationId(botId))}
            {...(botPort.clearRemoved && selected.c.kind === 'bot' && selected.c.removed ? { onClearArchived: clearArchived(selected.c.row.bot.id) } : {})}
            {...(threadAsk && threadAsk.conversationId === selected.c.id ? { threadAsk } : {})}
            {...(shownGroup && groupsPort.available ? { onEditGroup: () => setGroupDialog({ kind: 'edit', group: shownGroup }) } : {})}
          />
        ) : (
          <p className="wmux-bots-chat flex items-center justify-center text-[12px] text-[var(--text-muted)]">{t('botsPage.choose')}</p>
        )}
        </div>
      </>
    );
  }

  return (
    <div className="wmux-bots" data-bots-page data-view={view}>
      {body}
      {adding && (
        <Dialog onClose={() => setAdding(false)} width={520} data-testid="bots-add-bot">
          <DialogHeader title={t(adding === 'team' ? 'settings.factory.addTeam' : 'settings.factory.addBot')} closeLabel={t('settings.close')} />
          <DialogBody>
            <AddBotForm
              mode={adding}
              onDone={finishAdd}
              workspaces={addWorkspaces}
              botsOff={!on}
              turnOn={() => turnBotsOn(settingsPort, confirmOn)}
              {...(addTo ? { defaultWorkspaceId: addTo } : {})}
              {...(port ? { port } : {})}
            />
          </DialogBody>
        </Dialog>
      )}
      {groupDialog && (
        <BotsGroupDialog
          start={groupDialog}
          bots={bots}
          workspaces={addWorkspaces}
          port={groupsPort}
          t={t}
          onDone={groupDone}
          onClose={() => setGroupDialog(null)}
        />
      )}
      {guestsOpen && (
        <GuestBotsDialog
          t={t}
          port={guestsPort}
          conversations={guestConversations(model.conversations, (c) => conversationTitle(c, nameOf))}
          workspaceName={nameOf}
          botName={(id) => bots.find((b) => b.bot.id === id)?.bot.name ?? id}
          onClose={() => setGuestsOpen(false)}
        />
      )}
      {consent.dialog}
    </div>
  );
}

/** The conversations a guest bot may join: each live bot's 1:1 and each
 *  group chat. Pure. */
export function guestConversations(list: readonly Conversation[], title: (c: Conversation) => string): GuestConversationOption[] {
  const out: GuestConversationOption[] = [];
  for (const c of list) {
    if (c.kind === 'bot') {
      if (c.removed) continue;
      out.push({ scope: { workspaceId: c.row.bot.workspaceId, threadId: dmThreadId(c.row.bot.id) }, label: title(c) });
    } else {
      out.push({ scope: { workspaceId: c.group.workspaceId, threadId: c.threadId }, label: title(c) });
    }
  }
  return out;
}

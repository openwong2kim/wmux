// Hand out…: pick where a To hand out item goes, then main delivers it
// through the existing send paths (shared/handOut.ts HandOutPickRequest): an
// agent pane on this PC, a new worktree, or a company's CEO. Anchored to the
// item's card; Escape, a press outside or a resize closes it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HandOutEntry, HandOutPickResult, HandOutPickTarget } from '../../../shared/handOut';
import { prepNoticeToast, type HandoffTarget } from '../../../shared/gitHandoff';
import { agentDisplayToSlug } from '../../../shared/agentIdentity';
import { isRemoteWorkspaceId } from '../../../shared/a2aRemoteDelivery';
import { getLeafPanes, getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import type { Workspace } from '../../../shared/types';
import { useStore, type StoreState } from '../../stores';
import type { FleetRow } from '../../stores/selectors/fleet';
import { renderSentence } from '../../i18n/renderSentence';
import { displayPath } from '../../utils/displayPath';
import { shortDir } from '../../utils/shortDir';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';
import { paneTag } from '../../utils/paneNaming';
import { fanoutAgentStem, loadLastAgentCmd } from '../AgentToolbar/fanoutAgentCmd';
import { companyFolder } from '../Company/companyFolder';
import { allHandoffTargets, handoffTargetForPty } from '../Git/handoffDrag';
import { useAgentChoices } from '../Sidebar/CompanyPresetDialog';
import { workspaceFolder } from '../Sidebar/externalSessionPlacement';
import Button from '../ui/Button';
import Popover from '../ui/Popover';
import Select from '../ui/Select';
import { useModalLayer } from '../ui/modalLayer';
import {
  defaultHandOutOption, handOutOptions, handOutTargets,
  type HandOutOption, type HandOutPaneCandidate, type HandOutWorkspaceCandidate,
} from './handOutTargets';

type T = (key: string, vars?: Record<string, string | number>) => string;
type Anchor = { top: number; left: number; right: number; bottom: number };

const POPOVER_W = 420;
/** Arrow keys walk the targets, as in any radio group. */
const MOVES: Record<string, number | undefined> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

const PAD = 8;

/**
 * Where the popover sits: beside the card when it fits inside `bounds` (the
 * Fleet sheet), else under the card (above it when there is no room below),
 * left-aligned with it. Always inside `bounds`, narrower when the sheet is.
 */
export function placeHandOutPopover(anchor: Anchor, height: number, bounds: Anchor): { left: number; top: number; width: number } {
  const width = Math.max(0, Math.min(POPOVER_W, bounds.right - bounds.left - 2 * PAD));
  const minTop = bounds.top + PAD;
  const maxBottom = bounds.bottom - PAD;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  if (anchor.right + PAD + width <= bounds.right - PAD) {
    return { left: anchor.right + PAD, top: clamp(anchor.top, minTop, maxBottom - height), width };
  }
  const left = clamp(anchor.left, bounds.left + PAD, bounds.right - PAD - width);
  const below = anchor.bottom + 4;
  const above = anchor.top - 4 - height;
  const top = below + height <= maxBottom ? below : above >= minTop ? above : clamp(below, minTop, maxBottom - height);
  return { left, top, width };
}

/**
 * What a pick that went through still has to say, each a warning toast: a
 * new worktree's preparation notice; a send that was not delivered, with the
 * reason in the Git page's hand-off words; a delivered send not known to have
 * started a turn (a busy agent can take the paste and drop the Enter), with
 * the Git page's "check it started". A delivered send says nothing more.
 */
export function handOutPickNotices(
  res: Extract<HandOutPickResult, { ok: true }>,
  picked: HandOutOption,
  title: string,
  t: T,
): string[] {
  const out: string[] = [];
  const notice = res.prep ? prepNoticeToast(res.prep) : null;
  if (notice) out.push(t(notice.key, notice.values));
  if (picked.kind === 'worktree') return out;
  if (res.delivered === false) {
    const whyKey = `git.handoff.why.${res.reason ?? ''}`;
    const why = res.reason && t(whyKey) !== whyKey ? t(whyKey) : res.note;
    out.push(`${t('fleet.handOut.notDelivered', { title, target: picked.name })}${why ? ` ${why}` : ''}`);
  } else if (res.assurance === 'unverified') {
    out.push(t('git.handoff.pasted', {
      kind: t('fleet.handOut.task'),
      ref: `“${title}”`,
      agent: picked.kind === 'pane' ? picked.name || picked.target.agentName : picked.target.agentName || picked.name,
      workspace: picked.kind === 'pane' ? picked.workspaceName : picked.name,
    }));
  }
  return out;
}

/** A folder by its last two segments, in mono; the full path is its tooltip
 *  and what a screen reader reads. */
function FolderText({ folder }: { folder: string }) {
  const full = displayPath(folder);
  return (
    <span className="font-mono" title={full} data-hand-out-folder>
      <span aria-hidden="true">{shortDir(full)}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}

/**
 * The workspaces as the targets read them. A company's CEO is the first
 * terminal tab of its coordinator pane (the active one first) where an agent
 * runs, so a plain shell in front does not hide it. A stashed coordinator is
 * off screen, as stashed agent panes are, so its company is not offered;
 * the coordinator pane is named either way, so it is never offered as a pane.
 */
export function handOutWorkspaceCandidates(
  state: Pick<StoreState, 'workspaces' | 'surfaceAgent' | 'agentAliveByPtyId' | 'commandRunningByPtyId'>,
  workspaces: readonly Workspace[],
): HandOutWorkspaceCandidate[] {
  return workspaces.filter((ws) => !isRemoteWorkspaceId(ws.id)).map((ws): HandOutWorkspaceCandidate => {
    const folder = workspaceFolder(ws);
    if (!ws.company) return { workspaceId: ws.id, name: ws.name, folder };
    const coordinatorPaneId = ws.company.coordinatorPaneId ?? undefined;
    const visible = coordinatorPaneId ? getLeafPanes(ws.rootPane).find((l) => l.id === coordinatorPaneId) : undefined;
    const anyLeaf = visible ?? (coordinatorPaneId ? getWorkspaceLeafPanes(ws).find((l) => l.id === coordinatorPaneId) : undefined);
    const terminals = (visible?.surfaces ?? []).filter((sf) => (sf.surfaceType ?? 'terminal') === 'terminal' && sf.ptyId);
    const ordered = [...terminals.filter((sf) => sf.id === visible?.activeSurfaceId), ...terminals.filter((sf) => sf.id !== visible?.activeSurfaceId)];
    let ceo: HandoffTarget | undefined;
    for (const sf of ordered) {
      const target = sf.ptyId ? handoffTargetForPty(state, sf.ptyId) : null;
      if (target?.agentName) { ceo = target; break; }
    }
    return {
      workspaceId: ws.id,
      name: ws.name,
      folder,
      company: { folder: companyFolder(ws, anyLeaf), ...(coordinatorPaneId ? { coordinatorPaneId } : {}), ...(ceo ? { ceo } : {}) },
    };
  });
}

/** The agent panes and workspaces of this PC as the targets read them. */
function useCandidates(rows: readonly FleetRow[], workspaces: readonly Workspace[]) {
  const paneLabel = useStore((s) => s.paneLabel);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const agentAlive = useStore((s) => s.agentAliveByPtyId);
  const commandRunning = useStore((s) => s.commandRunningByPtyId);
  return useMemo(() => {
    const state = useStore.getState();
    const local = workspaces.filter((ws) => !isRemoteWorkspaceId(ws.id));
    const byId = new Map(local.map((ws) => [ws.id, ws]));
    const rowOf = new Map(rows.map((row) => [`${row.pane.workspaceId}\n${row.pane.paneId}`, row]));
    const panes = allHandoffTargets(state).flatMap((target): HandOutPaneCandidate[] => {
      const ws = byId.get(target.workspaceId);
      if (!ws) return [];
      const leaf = getWorkspaceLeafPanes(ws).find((l) => l.id === target.paneId);
      const label = (paneLabel[target.paneId] ?? leaf?.metadata?.label)?.trim();
      const row = rowOf.get(`${target.workspaceId}\n${target.paneId}`);
      const slug = target.agentSlug ?? agentDisplayToSlug(target.agentName);
      return [{
        target: slug ? { ...target, agentSlug: slug } : target,
        name: label && !/\s/.test(label) ? `#${label}` : leaf ? paneTag(ws, leaf) : '',
        workspaceName: ws.name,
        folder: leaf?.surfaces.find((sf) => sf.id === target.surfaceId)?.cwd ?? row?.pane.cwd,
        section: row?.section,
        idleForMs: row?.idleForMs,
      }];
    });
    return { panes, spaces: handOutWorkspaceCandidates(state, local) };
  }, [rows, workspaces, paneLabel, surfaceAgent, agentAlive, commandRunning]);
}

interface HandOutPopoverProps {
  item: HandOutEntry;
  anchor: Anchor;
  /** The Fleet sheet: the popover stays inside it. */
  bounds: Anchor;
  /** Every Fleet row, unfiltered: a pane's section and idle time. */
  rows: readonly FleetRow[];
  workspaces: readonly Workspace[];
  onClose: () => void;
  t: T;
}

export default function HandOutPopover({ item, anchor, bounds, rows, workspaces, onClose, t }: HandOutPopoverProps) {
  const { panes, spaces } = useCandidates(rows, workspaces);
  const targets = useMemo(() => handOutTargets(item, panes, spaces), [item, panes, spaces]);
  const options = useMemo(() => handOutOptions(targets), [targets]);
  const [chosen, setChosen] = useState<string | null>(() => defaultHandOutOption(options)?.key ?? null);
  const selected = options.find((option) => option.key === chosen) ?? defaultHandOutOption(options);
  const agents = useAgentChoices().filter((choice) => choice.installed);
  const [worktreeAgent, setWorktreeAgent] = useState<string | null>(null);
  const worktreeSlug = worktreeAgent
    ?? (item.agent && agents.some((choice) => choice.agent === item.agent) ? item.agent : agents[0]?.agent ?? 'claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(360);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const attachLayer = useModalLayer({ onEscape: onClose });
  const setPanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    attachLayer(el);
  }, [attachLayer]);
  useLayoutEffect(() => {
    const h = panelRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  // Focus the chosen target on open, else Cancel.
  useEffect(() => {
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? panel?.querySelector<HTMLElement>('[data-hand-out-cancel]'))?.focus();
  }, []);

  const choose = (option: HandOutOption, focus = false) => {
    setChosen(option.key);
    setError(null);
    if (focus) panelRef.current?.querySelector<HTMLElement>(`[data-hand-out-option="${CSS.escape(option.key)}"]`)?.focus();
  };

  const submit = async () => {
    const pick = window.electronAPI?.handOut?.pick;
    if (!pick || !selected || busy) return;
    let to: HandOutPickTarget;
    if (selected.kind === 'pane') to = { kind: 'pane', target: selected.target };
    else if (selected.kind === 'company') to = { kind: 'company', target: selected.target };
    else {
      // The fan-out's remembered command when it launches this agent (it may
      // carry the user's flags), else the agent itself.
      const last = loadLastAgentCmd();
      to = { kind: 'worktree', workspaceId: selected.workspaceId, agentCmd: last && fanoutAgentStem(last) === worktreeSlug ? last : worktreeSlug };
    }
    setBusy(true);
    setError(null);
    let res: HandOutPickResult | null;
    try {
      res = await pick({ itemId: item.id, to });
    } catch {
      res = null;
    }
    // Main records the pick's link before it sends, so the item leaves the
    // open list mid-pick and the caller may already have closed this. What
    // the pick has to say is still said, as a toast.
    const shown = mounted.current;
    const pushToast = useStore.getState().pushToast;
    const failure = !res ? t('fleet.handOut.pick.failed')
      : !res.ok ? (res.code === 'unknown' ? t('fleet.handOut.pick.unknown')
        : res.code === 'taken' ? t('fleet.handOut.pick.taken')
        : res.message || t('fleet.handOut.pick.failed'))
      : null;
    if (shown) setBusy(false);
    if (!res?.ok) {
      if (shown) setError(failure);
      else pushToast({ level: 'error', message: `“${item.title}”: ${failure}` });
      return;
    }
    if (shown) onClose();
    for (const message of handOutPickNotices(res, selected, item.title, t)) pushToast({ level: 'warn', message });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
    if (event.ctrlKey || event.metaKey || event.altKey || options.length === 0) return;
    const at = Math.max(0, options.findIndex((option) => option.key === selected?.key));
    const move = MOVES[event.key];
    if (move !== undefined) {
      event.preventDefault();
      choose(options[(at + move + options.length) % options.length], true);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      choose(options[event.key === 'Home' ? 0 : options.length - 1], true);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === ' ') {
      event.preventDefault();
      if (options[at]) choose(options[at]);
    }
  };

  const radio = (option: HandOutOption, body: React.ReactNode, tag?: string, dimmed = false) => {
    const checked = option.key === selected?.key;
    return (
      <div
        key={option.key}
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={() => choose(option)}
        className={`flex items-center gap-3 min-w-0 px-2 py-1.5 rounded-[8px] cursor-default outline-none focus-visible:![outline:2px_solid_var(--accent)] focus-visible:![outline-offset:-2px] ${checked ? 'bg-[var(--selection)]' : 'hover:bg-[var(--hover-fill)]'}`}
        data-hand-out-option={option.key}
      >
        <span aria-hidden="true" className="grid place-items-center flex-none w-[14px] h-[14px] rounded-full border border-[var(--line-strong)]">
          {checked && <span className="w-[6px] h-[6px] rounded-full bg-[var(--text-main)]" />}
        </span>
        <span className={`flex flex-col min-w-0 flex-1 ${dimmed ? 'opacity-50' : ''}`}>{body}</span>
        {tag && <span className={`flex-none text-[11px] text-[var(--text-muted)] ${dimmed ? 'opacity-70' : ''}`}>{tag}</span>}
      </div>
    );
  };
  const head = (text: string) => <div className="px-2 pt-2 pb-1 text-[11px] text-[var(--text-muted)]" aria-hidden="true">{text}</div>;
  const pos = placeHandOutPopover(anchor, height, bounds);

  return createPortal(
    <Popover
      ref={setPanel}
      padded
      role="dialog"
      aria-modal="true"
      aria-label={t('fleet.handOut.pick.title')}
      className="fixed flex flex-col gap-2"
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: bounds.bottom - bounds.top - 2 * PAD, overflowY: 'auto', zIndex: 'var(--z-dialog)' }}
      onKeyDown={onKeyDown}
      data-testid="fleet-hand-out"
    >
      <div className="flex flex-col gap-0.5">
        <p className="m-0 text-[13px] font-medium text-[var(--text-main)]">{t('fleet.handOut.pick.title')}</p>
        <p className="m-0 line-clamp-2 [overflow-wrap:anywhere] text-[12px] text-[var(--text-sub)]">
          {item.title}
          {' · '}<FolderText folder={item.folder} />
          {item.agent && ` · ${t('fleet.handOut.pick.asks', { agent: item.agent })}`}
        </p>
      </div>
      {options.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--text-muted)]" data-hand-out-none>{t('fleet.handOut.pick.none')}</p>
      ) : (
        <div role="radiogroup" aria-label={t('fleet.handOut.pick.title')} className="flex flex-col">
          {targets.panes.length > 0 && head(t('fleet.handOut.pick.panes'))}
          {targets.panes.map((option) => {
            const agent = option.target.agentSlug ?? option.target.agentName;
            const status = option.running ? t('fleet.handOut.pick.running')
              : option.idleForMs !== undefined && option.idleForMs >= IDLE_SHOW_AFTER_MS
                ? t('fleet.handOut.pick.idleFor', { age: formatIdle(option.idleForMs) }) : t('fleet.handOut.pick.idle');
            const tag = option.otherAgent && item.agent ? t('fleet.handOut.pick.notAgent', { agent: item.agent })
              : option.thisFolder ? t('fleet.handOut.pick.thisFolder') : undefined;
            return radio(option, (
              <>
                <span className="truncate text-[13px] text-[var(--text-main)]">{[option.name, agent].filter(Boolean).join(' · ')}</span>
                <span className="truncate text-[11px] text-[var(--text-sub)]">{[option.workspaceName, status].filter(Boolean).join(' · ')}</span>
              </>
            ), tag, option.otherAgent);
          })}
          {targets.worktree && head(t('fleet.handOut.pick.worktree'))}
          {targets.worktree && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-0">
                {radio(targets.worktree, (
                  <span className="truncate text-[13px] text-[var(--text-main)]">
                    {renderSentence(t('fleet.handOut.pick.worktreeOf'), { folder: <FolderText folder={targets.worktree.folder} /> })}
                  </span>
                ))}
              </div>
              <Select className="flex-none w-[120px]" value={worktreeSlug} aria-label={t('fleet.handOut.pick.worktreeAgent')}
                onChange={(e) => setWorktreeAgent(e.target.value)}
                onFocus={() => { if (targets.worktree) choose(targets.worktree); }} data-hand-out-worktree-agent>
                {agents.length === 0 && <option value={worktreeSlug}>{worktreeSlug}</option>}
                {agents.map((choice) => <option key={choice.agent} value={choice.agent}>{choice.agent}</option>)}
              </Select>
            </div>
          )}
          {targets.companies.length > 0 && head(t('fleet.handOut.pick.company'))}
          {targets.companies.map((option) => radio(option, (
            <>
              <span className="truncate text-[13px] text-[var(--text-main)]">{option.name}</span>
              <span className="truncate text-[11px] text-[var(--text-sub)]">{t('fleet.handOut.pick.companyNote')}</span>
            </>
          ), t('fleet.handOut.pick.thisFolder')))}
        </div>
      )}
      {error && <p role="alert" className="m-0 text-[12px] text-[var(--accent-red)] [overflow-wrap:anywhere]" data-hand-out-error>{error}</p>}
      <div className="flex items-center gap-2 pt-2">
        <p className="m-0 flex-1 min-w-0 text-[11px] leading-[15px] text-[var(--text-muted)]">{t('fleet.handOut.pick.footer')}</p>
        <Button variant="ghost" size="sm" onClick={onClose} data-hand-out-cancel>{t('fleet.handOut.form.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy || !selected} onClick={() => void submit()} data-hand-out-send>
          {busy ? t('fleet.handOut.pick.sending') : t('fleet.handOut.pick.send')}
        </Button>
      </div>
    </Popover>,
    document.body,
  );
}

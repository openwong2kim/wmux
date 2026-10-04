// The confirm step of handing an issue or PR to an agent: "Send issue
// owner/repo#n to <agent> in <workspace>?" with an optional note, Send /
// Cancel (Esc cancels), and "Start in a new worktree". Opened by a drop on an
// agent pane or a workspace row, or by the detail header's "Send to agent…"
// (then it lists the agent panes to pick from). Main does the rest
// (src/main/git/handoff.ts): the work link, the gated, typing-held delivery of
// a fixed reference.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import Popover from '../ui/Popover';
import { useModalLayer } from '../ui/modalLayer';
import { loadLastAgentCmd } from '../AgentToolbar/fanoutAgentCmd';
import { allHandoffTargets, handoffTargetsInWorkspace } from './handoffDrag';
import { sanitizeHandoffTitle, type HandoffInProgress, type HandoffSendResult, type HandoffStartResult, type HandoffTarget } from '../../../shared/gitHandoff';
import type { GitHandoffOpen } from './gitPageState';

interface HandoffBridge {
  handoffSend: (req: unknown) => Promise<HandoffSendResult>;
  handoffStartWorktree: (req: unknown) => Promise<HandoffStartResult>;
}

function bridge(): HandoffBridge | null {
  const gh = (window as unknown as { electronAPI?: { github?: Partial<HandoffBridge> } }).electronAPI?.github;
  return gh?.handoffSend && gh.handoffStartWorktree ? (gh as HandoffBridge) : null;
}

const POPOVER_W = 380;

export default function HandoffPopover(): React.ReactElement | null {
  const open = useStore((s) => s.gitHandoff);
  return open ? <HandoffPopoverBody key={`${open.item.kind}:${open.item.ref.url}:${open.target?.ptyId ?? open.workspaceId ?? ''}`} open={open} /> : null;
}

function HandoffPopoverBody({ open }: { open: GitHandoffOpen }): React.ReactElement | null {
  const t = useT();
  const pushToast = useStore((s) => s.pushToast);
  const workspaces = useStore((s) => s.workspaces);
  // Only this hand-off may close itself or update after an await: the store
  // may hold a newer one by then, or none, and the body may be gone.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const current = () => mounted.current && useStore.getState().gitHandoff === open;
  const close = useCallback(() => {
    if (useStore.getState().gitHandoff === open) useStore.getState().setGitHandoff(null);
  }, [open]);
  // The pane to send to: the dropped one, or a pick among a workspace's (or all) agents.
  const choices = useMemo<HandoffTarget[]>(() => {
    if (open.target) return [open.target];
    const st = useStore.getState();
    return open.workspaceId ? handoffTargetsInWorkspace(st, open.workspaceId) : allHandoffTargets(st);
  }, [open.target, open.workspaceId]);
  const [pick, setPick] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'send' | 'start' | null>(null);
  const [inProgress, setInProgress] = useState<{ action: 'send' | 'start'; info: HandoffInProgress } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const target = choices[pick] ?? null;
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;
  const kindWord = open.item.kind === 'issue' ? t('git.handoff.issue') : t('git.handoff.pr');
  const itemRef = `${open.item.ref.owner}/${open.item.ref.repo}#${open.item.ref.number}`;
  const agentWord = (tg: HandoffTarget) => tg.agentName || t('git.handoff.terminal');
  const canStart = open.item.kind === 'issue' && !!open.repo?.workspaceId;

  // A modal layer: Esc closes the top-most one, Tab stays inside, and focus
  // returns to where it was on close. A press outside cancels too.
  const attachLayer = useModalLayer({ onEscape: close });
  const setPanel = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    attachLayer(el);
  }, [attachLayer]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    noteRef.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [close]);

  const send = async (force = false) => {
    const b = bridge();
    if (!b || !target || busy) return;
    setBusy('send');
    setError(null);
    const res = await b.handoffSend({ item: open.item, target, note, force });
    if (!current()) return;
    setBusy(null);
    if (!res.ok) {
      if (res.code === 'in-progress') setInProgress({ action: 'send', info: res.inProgress });
      else setError(res.message);
      return;
    }
    close();
    const vars = { kind: kindWord, ref: itemRef, agent: agentWord(target), workspace: wsName(target.workspaceId) };
    pushToast(res.delivered
      ? { level: 'info', message: t('git.handoff.sent', vars) }
      : { level: 'warn', message: `${t('git.handoff.stored', vars)}${res.note ? ` ${res.note}` : ''}` });
  };

  const start = async (force = false) => {
    const b = bridge();
    if (!b || !canStart || !open.repo?.workspaceId || busy) return;
    setBusy('start');
    setError(null);
    const res = await b.handoffStartWorktree({
      item: open.item, repoPath: open.repo.repoPath, workspaceId: open.repo.workspaceId, agentCmd: loadLastAgentCmd() || undefined, note, force,
    });
    if (!current()) return;
    setBusy(null);
    if (!res.ok) {
      if (res.code === 'in-progress') setInProgress({ action: 'start', info: res.inProgress });
      else setError(res.message);
      return;
    }
    close();
    pushToast({ level: 'info', message: t('git.handoff.started', { kind: kindWord, ref: itemRef, branch: res.branch }) });
  };

  const pos = open.anchor
    ? {
        left: Math.max(8, Math.min(open.anchor.x, window.innerWidth - POPOVER_W - 8)),
        top: Math.max(8, Math.min(open.anchor.y, window.innerHeight - 320)),
      }
    : { left: Math.max(8, (window.innerWidth - POPOVER_W) / 2), top: Math.max(8, window.innerHeight * 0.25) };

  return (
    <div className="wmux-handoff-layer">
      <Popover
        ref={setPanel}
        padded
        role="dialog"
        aria-modal="true"
        aria-label={t('git.handoff.label')}
        className="wmux-handoff"
        style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
        data-testid="git-handoff"
      >
        {target && choices.length === 1 ? (
          <p className="wmux-handoff-title" data-handoff-question>
            {t('git.handoff.question', { kind: kindWord, ref: itemRef, agent: agentWord(target), workspace: wsName(target.workspaceId) })}
          </p>
        ) : (
          <>
            <p className="wmux-handoff-title">{t('git.handoff.pickQuestion', { kind: kindWord, ref: itemRef })}</p>
            {choices.length === 0 ? (
              <p className="wmux-handoff-note" data-handoff-none>{t('git.handoff.noAgents')}</p>
            ) : (
              <select
                className={`wmux-handoff-select ${FOCUS_RING}`}
                value={pick}
                onChange={(e) => setPick(Number(e.target.value))}
                aria-label={t('git.handoff.agent')}
                data-handoff-pick
              >
                {choices.map((c, i) => (
                  <option key={c.ptyId} value={i}>{`${agentWord(c)} — ${wsName(c.workspaceId)}`}</option>
                ))}
              </select>
            )}
          </>
        )}
        <p className="wmux-handoff-item" title={open.item.ref.url}>“{sanitizeHandoffTitle(open.item.ref.title)}”</p>
        <textarea
          ref={noteRef}
          className={`wmux-handoff-input ${FOCUS_RING}`}
          rows={2}
          value={note}
          placeholder={t('git.handoff.notePlaceholder')}
          aria-label={t('git.handoff.note')}
          onChange={(e) => setNote(e.target.value)}
          data-handoff-note
        />
        {inProgress && (
          <div className="wmux-handoff-warn" role="status" data-handoff-in-progress>
            <span>{t('git.handoff.inProgress', { workspace: wsName(inProgress.info.workspaceId) })}</span>
            <button
              type="button"
              className={`wmux-git-button ${FOCUS_RING}`}
              disabled={busy !== null}
              onClick={() => void (inProgress.action === 'send' ? send(true) : start(true))}
              data-handoff-anyway
            >
              {inProgress.action === 'send' ? t('git.handoff.sendAnyway') : t('git.handoff.startAnyway')}
            </button>
          </div>
        )}
        {error && <p className="wmux-handoff-error" role="alert">{error}</p>}
        <div className="wmux-handoff-actions">
          {canStart && (
            <button
              type="button"
              className={`wmux-git-button ${FOCUS_RING}`}
              disabled={busy !== null}
              onClick={() => void start()}
              data-handoff-start
            >
              {busy === 'start' ? t('git.handoff.starting') : t('git.handoff.startWorktree')}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={close} data-handoff-cancel>
            {t('git.handoff.cancel')}
          </button>
          <button
            type="button"
            className={`wmux-git-primary ${FOCUS_RING}`}
            disabled={busy !== null || !target}
            onClick={() => void send()}
            data-handoff-send
          >
            {busy === 'send' ? t('git.handoff.sending') : t('git.handoff.send')}
          </button>
        </div>
      </Popover>
    </div>
  );
}

// The Git page's ship button: one primary button whose label is the current
// branch's next step (Commit → Push → Create PR → Open PR, from the gitShip
// state machine), a menu with the other steps that can run now, and the
// reason when the next step cannot. Commit asks for a message; Create PR asks
// for a title (gh fills the body from the commits). Each write carries the
// branch and HEAD the user saw (when the dialog opened or the step started);
// main re-checks the step and refuses if either moved.
//
// A failed step says what went wrong in plain words when main named the
// cause (signing, a protected branch, new commits on the remote, a refused
// key or sign-in, a folder that is gone), with the one button that moves
// on from it; anything else is a short line over git's output, folded.
import { secretRefusalText } from './secretRefusal';
import { GH_LOGIN_COMMAND, openGithubLoginTab } from './connectGithub';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Popover from '../ui/Popover';
import { Icon } from '../icons';
import { shipBlock, shipState, type ShipAction, type ShipInput } from '../../../shared/gitShip';
import type { ShipActionResult, ShipCommitOptions, ShipExpect, ShipStatusResult } from '../../../main/git/shipActions';

interface ShipBridge {
  shipStatus: (repoPath: string) => Promise<ShipStatusResult>;
  shipCommit: (repoPath: string, message: string, expect: ShipExpect, opts?: ShipCommitOptions) => Promise<ShipActionResult>;
  shipPush: (repoPath: string, expect: ShipExpect) => Promise<ShipActionResult>;
  shipCreatePr: (repoPath: string, title: string, expect: ShipExpect) => Promise<ShipActionResult>;
}

/** Enter that is not finishing an IME composition (Korean, Japanese, Chinese input). */
const isPlainEnter = (e: React.KeyboardEvent) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;

function getShipBridge(): ShipBridge | null {
  const gh = (window as unknown as { electronAPI?: { github?: Partial<ShipBridge> } }).electronAPI?.github;
  return gh?.shipStatus && gh.shipCommit && gh.shipPush && gh.shipCreatePr ? (gh as ShipBridge) : null;
}

const LABEL: Record<ShipAction, string> = {
  commit: 'git.ship.commit',
  push: 'git.ship.push',
  createPr: 'git.ship.createPr',
  openPr: 'git.ship.openPr',
};

type Failed = Extract<ShipActionResult, { ok: false }>;
type T = ReturnType<typeof useT>;

/** The existing "open a folder" flow (the new-workspace folder picker): the
 *  Git page follows the active workspace, so it lands on the folder picked. */
async function chooseFolderAgain(): Promise<void> {
  const folders = await window.electronAPI?.dialog?.pickFolder?.();
  const folder = folders?.[0];
  if (!folder) return;
  const state = useStore.getState();
  state.addWorkspace(folder.split(/[/\\]/).filter(Boolean).pop() || 'Workspace', { startupCwd: folder });
  showWorkspaces(useStore.getState());
}

/** One failure: the plain words, the one next step, git's own output folded. */
function ShipFailure({ action, res, t, onUnsignedCommit, onCreatePr, createPrBlocked, busy }: {
  action: ShipAction;
  res: Failed;
  t: T;
  /** Commit once without signing (the open commit dialog's message). */
  onUnsignedCommit?: () => void;
  onCreatePr: () => void;
  /** Why Create PR cannot run now, or null. */
  createPrBlocked: string | null;
  busy: boolean;
}): React.ReactElement {
  const [help, setHelp] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const reason = res.secretScanFailed || res.secrets?.length ? null : res.reason ?? null;
  const line = res.secretScanFailed
    ? t('git.secret.scanFailed')
    : res.secrets?.length
      ? secretRefusalText(res.secrets, t)
      : reason === 'auth' && res.forge
        ? t(`git.ship.fail.auth.${res.forge}`)
        : reason
          ? t(`git.ship.fail.${reason}`)
          : `${t(`git.ship.failed.${action}`)}.`;
  const button = (label: string, onClick: () => void, extra: { disabled?: boolean; title?: string } = {}) => (
    <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={onClick} disabled={busy || extra.disabled} title={extra.title} data-git-ship-fix={label}>
      {label}
    </button>
  );
  const signIn = async () => {
    const ok = await openGithubLoginTab(t('git.connect.tabTitle'));
    // No tab could run it: say the command to run instead.
    if (!ok) pushToast({ level: 'info', message: GH_LOGIN_COMMAND });
  };
  let actions: React.ReactNode = null;
  if (reason === 'signing') {
    actions = (
      <>
        {onUnsignedCommit && button(t('git.ship.fail.signing.once'), onUnsignedCommit)}
        {button(t('git.ship.fail.signing.help'), () => setHelp((v) => !v))}
      </>
    );
  } else if (reason === 'protected') {
    // Create a PR only when that step can run; otherwise the step that can:
    // a new branch for these commits, made in the terminal.
    actions = createPrBlocked
      ? button(t('git.goTerminal'), () => showWorkspaces(useStore.getState()))
      : button(t('git.ship.fail.protected.action'), onCreatePr);
  } else if (reason === 'remote-ahead') {
    actions = button(t('git.ship.fail.remote-ahead.action'), () => showWorkspaces(useStore.getState()));
  } else if (reason === 'auth') {
    actions = res.forge === 'github'
      ? button(t('git.ship.fail.auth.action'), () => void signIn())
      : button(t('git.goTerminal'), () => showWorkspaces(useStore.getState()));
  } else if (reason === 'missing-folder') {
    actions = button(t('git.ship.fail.missing-folder.action'), () => void chooseFolderAgain());
  }
  const raw = !res.secrets?.length && !res.secretScanFailed && reason !== 'missing-folder' ? res.error.trim() : '';
  return (
    <div className="mt-2" role="alert" data-git-ship-failure={reason ?? (res.secrets?.length || res.secretScanFailed ? 'secrets' : 'other')}>
      <p className="wmux-git-ship-error" style={{ marginTop: 0 }}>{line}</p>
      {reason === 'protected' && createPrBlocked && (
        <p className="mt-1 text-[12px] text-[var(--text-muted)]" data-git-ship-next>{t('git.ship.fail.protected.next')}</p>
      )}
      {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      {help && <p className="mt-2 text-[12px] text-[var(--text-muted)]" data-git-ship-signing-help>{t('git.ship.fail.signing.helpText')}</p>}
      {raw && (
        <details className="mt-2 text-[11px] text-[var(--text-muted)]" data-git-ship-raw>
          <summary className="cursor-pointer select-none">{t('git.ship.fail.details')}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">{raw}</pre>
        </details>
      )}
    </div>
  );
}

export function ShipButton({ repoPath, mergeActive, refreshKey = 0, changeKey = '', onShipped }: {
  /** The current worktree. */
  repoPath: string;
  mergeActive: boolean;
  refreshKey?: number;
  /** Changes when the pushed git status changes, so the step is re-read. */
  changeKey?: string;
  /** After a write lands (the page reloads its git view). */
  onShipped?: () => void;
}): React.ReactElement | null {
  const t = useT();
  const [status, setStatus] = useState<Extract<ShipStatusResult, { ok: true }>['status'] | null>(null);
  // The last status read failed (the button stays, disabled, with this reason).
  const [statusError, setStatusError] = useState<Extract<ShipStatusResult, { ok: false }> | null>(null);
  // The branch + HEAD the open dialog acts on, captured when it opened.
  const [pinned, setPinned] = useState<ShipExpect | null>(null);
  // The repo answers belong to: a late answer for another repo is dropped.
  const repoRef = useRef(repoPath);
  repoRef.current = repoPath;
  const [busy, setBusy] = useState<ShipAction | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'commit' | 'createPr' | null>(null);
  const [text, setText] = useState('');
  // The last write's failure: shown in the open dialog, else under the button.
  const [failure, setFailure] = useState<{ action: ShipAction; res: Failed } | null>(null);
  const req = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const read = useCallback(async () => {
    const bridge = getShipBridge();
    if (!bridge) return;
    const mine = ++req.current;
    const repo = repoPath;
    const res = await bridge.shipStatus(repo);
    if (mine !== req.current || repoRef.current !== repo) return;
    if (res.ok) {
      setStatus(res.status);
      setStatusError(null);
    } else {
      setStatus(null);
      setStatusError(res);
    }
  }, [repoPath]);
  // Another repo starts blank; a re-read of the same one replaces the status
  // in place, so the button does not blink out on every refresh.
  useEffect(() => {
    setStatus(null);
    setStatusError(null);
  }, [repoPath]);
  useEffect(() => {
    void read();
    return () => { req.current++; };
  }, [read, refreshKey, changeKey]);

  // The menu (and a failure shown under the button) closes on an outside click or Escape.
  const floatingFailure = failure !== null && dialog === null;
  useEffect(() => {
    if (!menuOpen && !floatingFailure) return;
    const close = () => { setMenuOpen(false); if (floatingFailure) setFailure(null); };
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, floatingFailure]);

  if (!status) {
    // The step cannot be read: a disabled button that says why, not nothing.
    if (!statusError) return null;
    const gone = statusError.reason === 'missing-folder';
    return (
      <div className="wmux-git-ship" data-git-ship="unknown">
        <span className="wmux-git-ship-reason" data-git-ship-reason title={statusError.error}>
          {t(gone ? 'git.ship.fail.missing-folder' : 'git.ship.statusFailed')}
        </span>
        {/* A folder that is gone: its one next step takes the button's place. */}
        {gone ? (
          <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => void chooseFolderAgain()} data-git-ship-fix="missing-folder">
            {t('git.ship.fail.missing-folder.action')}
          </button>
        ) : (
          <button type="button" className={`wmux-git-primary ${FOCUS_RING}`} disabled data-git-ship-primary title={statusError.error}>
            {t('git.ship.commit')}
          </button>
        )}
      </div>
    );
  }
  const input: ShipInput = {
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    hasUpstream: status.upstream !== null,
    detached: status.detached,
    onDefaultBranch: status.branch !== null && status.branch === status.defaultBranch,
    defaultBranchKnown: status.defaultBranch !== null,
    conflicts: status.conflicts,
    inProgress: status.inProgress,
    pr: status.pr,
    mergeActive,
  };
  // What a write is pinned to: the branch and HEAD on screen now.
  const pinNow: ShipExpect | null = status.branch ? { branch: status.branch, head: status.head } : null;
  const ship = shipState(input);

  const finish = async (action: ShipAction, res: ShipActionResult, repo: string) => {
    if (repoRef.current !== repo) return;
    setBusy(null);
    if (!res.ok) {
      setFailure({ action, res });
      return;
    }
    setFailure(null);
    setDialog(null);
    if (action === 'createPr' && res.url) window.open(res.url, '_blank');
    await read();
    onShipped?.();
  };

  const run = async (action: ShipAction) => {
    setMenuOpen(false);
    setFailure(null);
    const bridge = getShipBridge();
    if (!bridge || busy) return;
    if (action === 'openPr') {
      if (status.pr) window.open(status.pr.url, '_blank');
      return;
    }
    if (!pinNow) return;
    if (action === 'commit' || action === 'createPr') {
      setText(action === 'commit' ? '' : status.headSubject);
      setPinned(pinNow);
      setDialog(action);
      return;
    }
    const repo = repoPath;
    setBusy('push');
    await finish('push', await bridge.shipPush(repo, pinNow), repo);
  };

  /** `opts` only from the signing failure's "without signing" click. */
  const submit = async (opts?: ShipCommitOptions) => {
    const bridge = getShipBridge();
    if (!bridge || !dialog || !pinned || busy || !text.trim()) return;
    setFailure(null);
    setBusy(dialog);
    const repo = repoPath;
    const res = dialog === 'commit'
      ? await (opts ? bridge.shipCommit(repo, text, pinned, opts) : bridge.shipCommit(repo, text, pinned))
      : await bridge.shipCreatePr(repo, text, pinned);
    await finish(dialog, res, repo);
  };

  const { primary, menu } = ship;
  const reason = primary.blocked ? t(`git.ship.blocked.${primary.blocked}`) : '';
  // Open PR stays one click away while the next step is something else.
  const openPrBeside = !!status.pr && primary.action !== 'openPr';
  const createPrBlock = shipBlock('createPr', input);
  const failureEl = (inDialog: boolean) => failure && (
    <ShipFailure
      action={failure.action}
      res={failure.res}
      t={t}
      busy={busy !== null}
      onUnsignedCommit={inDialog && dialog === 'commit' ? () => void submit({ noSign: true }) : undefined}
      onCreatePr={() => { setDialog(null); void run('createPr'); }}
      createPrBlocked={createPrBlock ? t(`git.ship.blocked.${createPrBlock}`) : null}
    />
  );

  return (
    <div className="wmux-git-ship" data-git-ship={primary.action} ref={menuRef}>
      {primary.blocked && <span className="wmux-git-ship-reason" data-git-ship-reason>{reason}</span>}
      {openPrBeside && (
        <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => void run('openPr')} data-git-open-pr>
          {t('git.openPr')}
        </button>
      )}
      <div className="wmux-git-ship-group">
        <button
          type="button"
          className={`wmux-git-primary wmux-git-ship-primary ${FOCUS_RING}`}
          disabled={!!primary.blocked || busy !== null}
          title={reason || undefined}
          onClick={() => void run(primary.action)}
          data-git-ship-primary
        >
          {busy ? t(`git.ship.busy.${busy}`) : t(LABEL[primary.action])}
        </button>
        {/* The menu is drawn only when it has something in it. */}
        {menu.length > 0 && (
          <button
            type="button"
            className={`wmux-git-primary wmux-git-ship-caret ${FOCUS_RING}`}
            aria-label={t('git.ship.more')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy !== null}
            onClick={() => setMenuOpen((v) => !v)}
            data-git-ship-more
          >
            <Icon size={12}><polyline points="3.5,5.5 7,9 10.5,5.5" /></Icon>
          </button>
        )}
      </div>
      {floatingFailure && !menuOpen && (
        <Popover padded className="wmux-git-ship-menu" style={{ width: 360 }} data-testid="git-ship-failure">
          {failureEl(false)}
        </Popover>
      )}
      {menuOpen && (
        <Popover role="menu" className="wmux-git-ship-menu" data-testid="git-ship-menu">
          {menu.map((a) => (
            <button key={a} type="button" role="menuitem" className={`wmux-git-ship-item ${FOCUS_RING}`} onClick={() => void run(a)} data-git-ship-item={a}>
              {t(LABEL[a])}
            </button>
          ))}
        </Popover>
      )}
      {dialog && (
        <Dialog onClose={() => { if (!busy) { setDialog(null); setFailure(null); } }} width={460} data-testid={`git-ship-${dialog}`}>
          <DialogHeader
            title={t(dialog === 'commit' ? 'git.ship.commitTitle' : 'git.ship.createPrTitle')}
            description={dialog === 'commit'
              ? t(status.dirty === 1 ? 'git.ship.commitDescOne' : 'git.ship.commitDesc', { count: status.dirty })
              : t('git.ship.createPrDesc', { branch: status.branch ?? '' })}
            closeLabel={t('git.ship.cancel')}
            closeDisabled={busy !== null}
          />
          <DialogBody>
            {dialog === 'commit' ? (
              <textarea
                className={`wmux-git-ship-input ${FOCUS_RING}`}
                rows={4}
                value={text}
                autoFocus
                placeholder={t('git.ship.commitPlaceholder')}
                aria-label={t('git.ship.commitTitle')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (isPlainEnter(e) && (e.metaKey || e.ctrlKey)) void submit(); }}
                data-git-ship-text
              />
            ) : (
              <input
                type="text"
                className={`wmux-git-ship-input ${FOCUS_RING}`}
                value={text}
                autoFocus
                aria-label={t('git.ship.prTitleLabel')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (isPlainEnter(e)) void submit(); }}
                data-git-ship-text
              />
            )}
            {failureEl(true)}
          </DialogBody>
          <DialogFooter>
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy !== null} onClick={() => { setDialog(null); setFailure(null); }}>
              {t('git.ship.cancel')}
            </button>
            <button
              type="button"
              className={`wmux-git-primary ${FOCUS_RING}`}
              disabled={busy !== null || !text.trim()}
              onClick={() => void submit()}
              data-git-ship-submit
            >
              {busy ? t(`git.ship.busy.${busy}`) : t(LABEL[dialog])}
            </button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

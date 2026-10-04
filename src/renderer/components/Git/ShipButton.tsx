// The Git page's ship button: one primary button whose label is the current
// branch's next step (Commit → Push → Create PR → Open PR, from the gitShip
// state machine), a menu with the other steps that can run now, and the
// reason when the next step cannot. Commit asks for a message; Create PR asks
// for a title (gh fills the body from the commits). main re-checks every step
// before it runs it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Popover from '../ui/Popover';
import { Icon } from '../icons';
import { shipState, type ShipAction, type ShipInput } from '../../../shared/gitShip';
import type { ShipActionResult, ShipStatusResult } from '../../../main/git/shipActions';

interface ShipBridge {
  shipStatus: (repoPath: string) => Promise<ShipStatusResult>;
  shipCommit: (repoPath: string, message: string) => Promise<ShipActionResult>;
  shipPush: (repoPath: string) => Promise<ShipActionResult>;
  shipCreatePr: (repoPath: string, title: string) => Promise<ShipActionResult>;
}

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
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<Extract<ShipStatusResult, { ok: true }>['status'] | null>(null);
  const [busy, setBusy] = useState<ShipAction | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'commit' | 'createPr' | null>(null);
  const [text, setText] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const req = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const read = useCallback(async () => {
    const bridge = getShipBridge();
    if (!bridge) return;
    const mine = ++req.current;
    const res = await bridge.shipStatus(repoPath);
    if (mine !== req.current) return;
    setStatus(res.ok ? res.status : null);
  }, [repoPath]);
  // Another repo starts blank; a re-read of the same one replaces the status
  // in place, so the button does not blink out on every refresh.
  useEffect(() => { setStatus(null); }, [repoPath]);
  useEffect(() => {
    void read();
    return () => { req.current++; };
  }, [read, refreshKey, changeKey]);

  // The menu closes on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  if (!status) return null;
  const input: ShipInput = {
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    hasUpstream: status.upstream !== null,
    detached: status.detached,
    onDefaultBranch: status.branch !== null && status.branch === status.defaultBranch,
    pr: status.pr,
    mergeActive,
  };
  const ship = shipState(input);

  const finish = async (action: ShipAction, res: ShipActionResult) => {
    setBusy(null);
    if (!res.ok) {
      if (dialog) setDialogError(res.error);
      else pushToast({ level: 'warn', message: `${t(`git.ship.failed.${action}`)}: ${res.error}` });
      return;
    }
    setDialog(null);
    if (action === 'createPr' && res.url) window.open(res.url, '_blank');
    await read();
    onShipped?.();
  };

  const run = async (action: ShipAction) => {
    setMenuOpen(false);
    const bridge = getShipBridge();
    if (!bridge || busy) return;
    if (action === 'openPr') {
      if (status.pr) window.open(status.pr.url, '_blank');
      return;
    }
    if (action === 'commit') {
      setText('');
      setDialogError(null);
      setDialog('commit');
      return;
    }
    if (action === 'createPr') {
      setText(status.headSubject);
      setDialogError(null);
      setDialog('createPr');
      return;
    }
    setBusy('push');
    await finish('push', await bridge.shipPush(repoPath));
  };

  const submit = async () => {
    const bridge = getShipBridge();
    if (!bridge || !dialog || busy || !text.trim()) return;
    setDialogError(null);
    setBusy(dialog);
    const res = dialog === 'commit' ? await bridge.shipCommit(repoPath, text) : await bridge.shipCreatePr(repoPath, text);
    await finish(dialog, res);
  };

  const { primary, menu } = ship;
  const reason = primary.blocked ? t(`git.ship.blocked.${primary.blocked}`) : '';
  // Open PR stays one click away while the next step is something else.
  const openPrBeside = !!status.pr && primary.action !== 'openPr';

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
        <Dialog onClose={() => { if (!busy) setDialog(null); }} width={460} data-testid={`git-ship-${dialog}`}>
          <DialogHeader
            title={t(dialog === 'commit' ? 'git.ship.commitTitle' : 'git.ship.createPrTitle')}
            description={dialog === 'commit'
              ? t('git.ship.commitDesc', { count: status.dirty })
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
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
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
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                data-git-ship-text
              />
            )}
            {dialogError && <p className="wmux-git-ship-error" role="alert">{dialogError}</p>}
          </DialogBody>
          <DialogFooter>
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy !== null} onClick={() => setDialog(null)}>
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

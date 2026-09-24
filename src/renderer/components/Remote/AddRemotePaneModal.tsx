import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import { FOCUS_RING } from '../focusRing';
import { IconRemoteDevices } from '../icons';
import type { RemoteHostPublic } from '../../../shared/remoteHosts';

export interface AddRemotePaneModalProps {
  onClose: () => void;
  /** Resolves once a session exists on the chosen host — the caller adds the
   *  surface to its own pane; this component only picks the host and mints
   *  the remote session.
   *
   *  #1329 — `workspaceId` is the id this modal minted for that session on the
   *  host. It used to stay private here ("opaque bookkeeping, never referenced
   *  again"), which is precisely why the pane it produced had no way to ask
   *  the host about its own agent: `/api/workspaces` is keyed by this id. */
  onCreated: (hostId: string, sessionId: string, workspaceId: string) => void;
  /** Heading shown above the host list. The modal serves three menu entries
   *  since #1140 (tab, split right, split down), and the heading is the only
   *  place the dialog can say which one it is answering — omitted falls back
   *  to the tab flow's "New remote pane". */
  title?: string;
}

/**
 * #1086/#1091 — "Add remote pane": pick one of the already-paired hosts
 * (same list `AttachRemoteModal` shows) and bootstrap a fresh session on it
 * via `remote.workspaceCreate` (#1001's operator-mint path). The `workspaceId`
 * that call requires is minted here purely to satisfy the bootstrap contract —
 * this feature does not create a remote "workspace" the user ever sees.
 *
 * #1329 — it IS handed back to the caller, though. The remote daemon groups its
 * sessions into `/api/workspaces` rows by exactly this id, and that listing is
 * the only channel carrying the session's agent name/status to this desktop.
 * Dropping the id (the original behaviour) left every pane this modal created
 * permanently agent-less in the sidebar roster and in `pane_list` (#1322).
 */
export default function AddRemotePaneModal({ onClose, onCreated, title }: AddRemotePaneModalProps) {
  const t = useT();
  const [hosts, setHosts] = useState<RemoteHostPublic[] | null>(null);
  const [creatingHostId, setCreatingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.remote?.hostsList().then((list) => {
      if (!cancelled) setHosts(list);
    });
    return () => { cancelled = true; };
  }, []);

  const pick = async (hostId: string): Promise<void> => {
    setError(undefined);
    const remote = window.electronAPI?.remote;
    // #1100, CodeRabbit round 1 — the guard must run BEFORE the spinner
    // latches: a missing bridge with no reset would leave every host button
    // disabled forever (setCreatingHostId(null) was only reachable after
    // this line). The `await` below gets the same protection via try/catch —
    // a rejected IPC call (as opposed to an { ok: false } response, already
    // handled) is the second way to strand the same spinner, and the caller
    // (`onClick={() => void pick(h.id)}`) attaches no handler of its own, so
    // an uncaught rejection here would surface as a genuine unhandled
    // promise rejection, not just leave the spinner stuck.
    if (!remote) return;
    setCreatingHostId(hostId);
    const freshId = `remote-pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await remote.workspaceCreate(hostId, freshId);
      if (res.ok) {
        onCreated(hostId, res.sessionId, freshId);
        onClose();
      } else {
        setError(res.error);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingHostId(null);
    }
  };

  // Escape and the backdrop close it (ui/Dialog) — until #1140 the backdrop
  // click was the only way out of this dialog.
  return (
    <Dialog onClose={onClose} closeOnBackdrop width={380} zIndexClassName="z-[var(--z-modal)]">
      <DialogHeader title={title ?? t('pane.newRemote')} />
      <DialogBody className="!gap-3">
        {error && <p className="ui-row-error !m-0 text-[13px] leading-5" role="alert">{error}</p>}
        {hosts === null ? (
          <p className="m-0 text-[13px] text-[var(--text-sub)]">…</p>
        ) : hosts.length === 0 ? (
          <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('remote.noHostsHint')}</p>
        ) : (
          <div className="ui-group">
            {hosts.map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={creatingHostId !== null}
                className={`ui-row w-full text-left hover:bg-[var(--surface-fill-hover)] disabled:opacity-50 ${FOCUS_RING}`}
                onClick={() => void pick(h.id)}
              >
                <span className="ui-row-icon" aria-hidden="true"><IconRemoteDevices size={14} /></span>
                <span className="ui-row-text">
                  <span className="ui-row-title truncate">{h.label || h.origin}</span>
                  {h.label && h.label !== h.origin && (
                    <span className="ui-row-detail font-mono truncate">{h.origin}</span>
                  )}
                </span>
                {creatingHostId === h.id && <span className="text-[13px] text-[var(--text-sub)]">…</span>}
              </button>
            ))}
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}

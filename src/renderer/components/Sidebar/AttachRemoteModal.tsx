import { useCallback, useEffect, useRef, useState } from 'react';
// Aliased: the Escape-key effect below binds a DOM listener and needs the
// global KeyboardEvent, so React's must not shadow it.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { remoteAttachmentKey } from '../../../shared/remoteHosts';
import type { PairFailureReason, RemoteHostPublic, RemoteWorkspaceSummary } from '../../../shared/remoteHosts';

type AddHostMode = 'pair' | 'url';

/** Maps a REMOTE_HOSTS_PAIR failure reason to its translated message —
 *  i18n lives here, renderer-side, not in main. */
function pairReasonMessage(t: ReturnType<typeof useT>, reason: PairFailureReason, attemptsLeft?: number): string {
  switch (reason) {
    case 'invalid-origin': return t('remote.pairInvalidOrigin');
    case 'already-registered': return t('remote.pairAlreadyRegistered');
    case 'expired': return t('remote.pairExpired');
    case 'too-many-attempts': return t('remote.pairTooManyAttempts');
    case 'invalid-code': return t('remote.pairInvalidCode', { n: attemptsLeft ?? 0 });
    case 'insecure-transport': return t('remote.pairInsecure');
    case 'unreachable': return t('remote.pairUnreachable');
    case 'incompatible': return t('remote.pairIncompatible');
    case 'pairing-failed': return t('remote.pairFailed');
  }
}

interface AttachRemoteModalProps {
  onClose: () => void;
}

/**
 * Left: registered hosts + an "Add host" row. Right: the selected host's
 * workspaces, each attachable. The paste-URL input is masked like a password
 * field — the URL embeds the bearer token, so it must never be echoed
 * anywhere (this input, toasts, or error strings).
 */
export default function AttachRemoteModal({ onClose }: AttachRemoteModalProps) {
  const t = useT();
  const attachRemoteWorkspace = useStore((s) => s.attachRemoteWorkspace);

  const [hosts, setHosts] = useState<RemoteHostPublic[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(true);

  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  // The LIVE selection, for `autoSelect` to consult after an await. Reading
  // `selectedHostId` there reads whatever the closure captured when the pair
  // request started — which is `null` in the exact case the guard exists for:
  // the operator picking a host while that request is still in flight.
  const selectedHostIdRef = useRef<string | null>(null);
  useEffect(() => { selectedHostIdRef.current = selectedHostId; }, [selectedHostId]);
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  const [addMode, setAddMode] = useState<AddHostMode>('pair');

  const [addUrl, setAddUrl] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [pairOrigin, setPairOrigin] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairLabel, setPairLabel] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);

  const refreshHosts = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote) return [];
    try {
      const list = await remote.hostsList();
      setHosts(list);
      return list;
    } catch {
      // IPC rejection (e.g. daemon hiccup) — leave the previously-shown list
      // as-is rather than throwing out of an effect/callback.
      return [];
    }
  }, []);

  useEffect(() => {
    setLoadingHosts(true);
    refreshHosts().finally(() => setLoadingHosts(false));
  }, [refreshHosts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Guards against a stale-response race: select host A then quickly B — if
  // A's workspacesList resolves after B's, it must not overwrite B's list.
  // Only the response matching the CURRENT request sequence number is
  // allowed to commit state.
  const selectRequestSeq = useRef(0);

  const selectHost = useCallback(async (hostId: string) => {
    const seq = ++selectRequestSeq.current;
    setSelectedHostId(hostId);
    setWorkspaces([]);
    setWorkspacesError(null);
    setCreateWorkspaceError(null);
    setLoadingWorkspaces(true);
    const remote = window.electronAPI?.remote;
    if (!remote) { setLoadingWorkspaces(false); return; }
    try {
      const res = await remote.workspacesList(hostId);
      if (seq !== selectRequestSeq.current) return; // a newer selectHost superseded this one
      if (res.ok) {
        setWorkspaces(res.workspaces);
        // allowInput may be stale/undefined until a probe runs — a successful
        // workspacesList call IS that probe, so refetch hosts here to pick up
        // the freshened flag before deciding the read-only tag below.
        await refreshHosts();
      } else {
        setWorkspacesError(res.error);
      }
    } catch {
      // Unexpected IPC rejection — surface a generic error instead of
      // leaving loadingWorkspaces stuck true forever.
      if (seq !== selectRequestSeq.current) return;
      setWorkspacesError(t('remote.workspacesFailed'));
    } finally {
      if (seq === selectRequestSeq.current) setLoadingWorkspaces(false);
    }
  }, [refreshHosts, t]);

  /**
   * Show the host that was just registered.
   *
   * Registering IS the request to look at that host, and without this the
   * right pane keeps rendering its no-host-selected state — a successful pair
   * that looks exactly like a no-op.
   *
   * Two constraints it has to respect:
   *
   *  - NOT awaited by the caller. `selectHost` probes the remote for its
   *    workspace list, which can run to the full RPC timeout; awaiting it
   *    inside the try would hold `pairing`/`adding` true for that whole time,
   *    leaving the form blank and the button disabled long after the
   *    registration itself succeeded — indistinguishable from a failure.
   *  - Skipped once the operator has picked a host themselves. `selectHost`
   *    sets `selectedHostId` unconditionally (its seq guard covers only the
   *    RESPONSE), so a late auto-select would yank the pane away from a host
   *    they chose while the pairing request was in flight.
   */
  const autoSelect = useCallback((hostId: string) => {
    if (selectedHostIdRef.current !== null) return;
    void selectHost(hostId);
  }, [selectHost]);

  const handleAddHost = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote || !addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await remote.hostsAdd(addUrl.trim(), addLabel.trim() || undefined);
      if (res.ok) {
        setAddUrl('');
        setAddLabel('');
        await refreshHosts();
        autoSelect(res.host.id);
      } else {
        setAddError(res.error);
      }
    } catch {
      // An IPC rejection (not the {ok:false} error-result path) must still
      // reset `adding` and surface something — otherwise the Add button
      // stays disabled forever with no visible feedback.
      setAddError(t('remote.addFailed'));
    } finally {
      setAdding(false);
    }
  }, [addUrl, addLabel, refreshHosts, autoSelect, t]);

  const handlePairHost = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote || !pairOrigin.trim() || !pairCode.trim()) return;
    setPairing(true);
    setPairError(null);
    try {
      const res = await remote.hostsPair(pairOrigin.trim(), pairCode.trim(), pairLabel.trim() || undefined);
      if (res.ok) {
        setPairOrigin('');
        setPairCode('');
        setPairLabel('');
        await refreshHosts();
        autoSelect(res.host.id);
      } else {
        setPairError(pairReasonMessage(t, res.reason, res.attemptsLeft));
      }
    } catch {
      // An IPC rejection (not the {ok:false} error-result path) must still
      // reset `pairing` and surface something — mirrors handleAddHost's I4
      // discipline for the paste-URL flow.
      setPairError(t('remote.pairFailed'));
    } finally {
      setPairing(false);
    }
  }, [pairOrigin, pairCode, pairLabel, refreshHosts, autoSelect, t]);

  const handleRemoveHost = useCallback(async (hostId: string) => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    try {
      await remote.hostsRemove(hostId);
      // Main cascades the persisted descriptors, but the renderer's mirrors
      // are memory-only: without this they stay in the sidebar for the rest of
      // the session and fail every poll as an unknown host.
      const orphans = useStore.getState().remoteWorkspaces.filter((w) => w.hostId === hostId);
      for (const w of orphans) useStore.getState().detachRemoteWorkspace(w.key);
    } finally {
      if (selectedHostId === hostId) {
        setSelectedHostId(null);
        setWorkspaces([]);
        setWorkspacesError(null);
      }
      await refreshHosts();
    }
  }, [refreshHosts, selectedHostId]);

  const handleAttach = useCallback((ws: RemoteWorkspaceSummary) => {
    const host = hosts.find((h) => h.id === selectedHostId);
    if (!host) return;
    attachRemoteWorkspace({
      key: remoteAttachmentKey(host.id, ws.id),
      hostId: host.id,
      hostLabel: host.label,
      workspaceId: ws.id,
      name: ws.name,
      panes: ws.panes,
    });
    onClose();
  }, [hosts, selectedHostId, attachRemoteWorkspace, onClose]);

  /**
   * Bootstraps the FIRST pane of a brand-new workspace on the selected host
   * (#1001) — the desktop mints the id (the daemon has no registry of its
   * own to mint one from), calls the operator-authenticated create route,
   * then attaches exactly like picking an existing workspace does.
   */
  const handleCreateWorkspace = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    const host = hosts.find((h) => h.id === selectedHostId);
    if (!remote?.workspaceCreate || !host) return;
    setCreatingWorkspace(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceId = crypto.randomUUID();
      const res = await remote.workspaceCreate(host.id, workspaceId);
      if (!res.ok) {
        setCreateWorkspaceError(t('remote.createWorkspaceFailed', { error: res.error }));
        return;
      }
      attachRemoteWorkspace({
        key: remoteAttachmentKey(host.id, workspaceId),
        hostId: host.id,
        hostLabel: host.label,
        workspaceId,
        name: '',
        panes: [{ sessionId: res.sessionId }],
      });
      onClose();
    } catch {
      setCreateWorkspaceError(t('remote.createWorkspaceFailed', { error: t('remote.workspacesFailed') }));
    } finally {
      setCreatingWorkspace(false);
    }
  }, [hosts, selectedHostId, attachRemoteWorkspace, onClose, t]);

  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? null;

  // Single source for "can this form submit". The Enter guard and the button's
  // disabled prop read the same const so they cannot drift into Enter firing a
  // request the button is presenting as unavailable.
  const pairDisabled = pairing || !pairOrigin.trim() || !pairCode.trim();
  const addDisabled = adding || !addUrl.trim();

  const submitOnEnter = (disabled: boolean, run: () => void) =>
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // isComposing: mid-IME Enter commits the candidate text, it does not
      // mean submit. Swallowing it here would eat the composition instead.
      if (e.key !== 'Enter' || e.nativeEvent.isComposing || disabled) return;
      e.preventDefault();
      run();
    };

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal-top)] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[640px] max-h-[80vh] rounded-[7px] shadow-2xl flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b" style={{ borderColor: 'var(--bg-overlay)' }}>
          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
            {t('remote.attachTitle')}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Left: hosts + add-host row */}
          <div
            className="w-[240px] flex-shrink-0 border-r overflow-y-auto px-3 py-3"
            style={{ borderColor: 'var(--bg-overlay)' }}
          >
            <div className="space-y-1">
              {loadingHosts ? (
                <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('remote.loading')}</div>
              ) : (
                hosts.map((host) => (
                  <div key={host.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left px-2 py-1.5 rounded text-[12px] font-mono truncate"
                      style={{
                        background: host.id === selectedHostId ? 'var(--bg-overlay)' : 'transparent',
                        color: host.id === selectedHostId ? 'var(--text-main)' : 'var(--text-sub)',
                      }}
                      onClick={() => selectHost(host.id)}
                    >
                      {host.label}
                    </button>
                    <button
                      type="button"
                      title={t('remote.removeHost')}
                      aria-label={t('remote.removeHost')}
                      className="flex-shrink-0 px-1.5 py-1 rounded text-[11px] font-mono"
                      style={{ color: 'var(--text-subtle)' }}
                      onClick={() => handleRemoveHost(host.id)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="border-t my-3" style={{ borderColor: 'var(--bg-overlay)' }} />

            <div className="flex gap-1 mb-2">
              <button
                type="button"
                className="flex-1 px-2 py-1 rounded text-[11px] font-mono"
                style={{
                  background: addMode === 'pair' ? 'var(--bg-overlay)' : 'transparent',
                  color: addMode === 'pair' ? 'var(--text-main)' : 'var(--text-subtle)',
                }}
                onClick={() => setAddMode('pair')}
              >
                {t('remote.pairTab')}
              </button>
              <button
                type="button"
                className="flex-1 px-2 py-1 rounded text-[11px] font-mono"
                style={{
                  background: addMode === 'url' ? 'var(--bg-overlay)' : 'transparent',
                  color: addMode === 'url' ? 'var(--text-main)' : 'var(--text-subtle)',
                }}
                onClick={() => setAddMode('url')}
              >
                {t('remote.urlTab')}
              </button>
            </div>

            {addMode === 'pair' ? (
              <div className="space-y-1.5">
                <div className="text-[10px]" style={{ color: 'var(--text-subtle)' }}>{t('remote.pairHint')}</div>
                <Input
                  type="text"
                  placeholder={t('remote.hostAddressHint')}
                  value={pairOrigin}
                  onChange={(e) => setPairOrigin(e.target.value)}
                  onKeyDown={submitOnEnter(pairDisabled, handlePairHost)}
                  className="text-[11px] font-mono w-full"
                  autoComplete="off"
                  aria-label={t('remote.hostAddress')}
                />
                {/* Not masked — this is an 8-char single-use, short-lived
                    code, and it is already displayed openly on the remote
                    screen, unlike a long-lived bearer token. */}
                <Input
                  type="text"
                  placeholder={t('remote.pairCode')}
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  onKeyDown={submitOnEnter(pairDisabled, handlePairHost)}
                  className="text-[11px] font-mono w-full"
                  autoComplete="off"
                  aria-label={t('remote.pairCode')}
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={pairLabel}
                  onChange={(e) => setPairLabel(e.target.value)}
                  onKeyDown={submitOnEnter(pairDisabled, handlePairHost)}
                  className="text-[11px] font-mono w-full"
                />
                <Button
                  variant="secondary"
                  className="w-full text-[11px]"
                  disabled={pairDisabled}
                  onClick={handlePairHost}
                >
                  {t('remote.pair')}
                </Button>
                {pairError && (
                  <div className="text-[10px]" style={{ color: 'var(--accent-red)' }}>{pairError}</div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* Masked like a password — the URL carries the bearer token. */}
                <Input
                  type="password"
                  placeholder={t('remote.pasteUrlHint')}
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  onKeyDown={submitOnEnter(addDisabled, handleAddHost)}
                  className="text-[11px] font-mono w-full"
                  autoComplete="off"
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  onKeyDown={submitOnEnter(addDisabled, handleAddHost)}
                  className="text-[11px] font-mono w-full"
                />
                <Button
                  variant="secondary"
                  className="w-full text-[11px]"
                  disabled={addDisabled}
                  onClick={handleAddHost}
                >
                  {t('remote.addHost')}
                </Button>
                {addError && (
                  <div className="text-[10px]" style={{ color: 'var(--accent-red)' }}>{addError}</div>
                )}
              </div>
            )}
          </div>

          {/* Right: the selected host's workspaces */}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 py-3 space-y-2">
            {/* Two distinct nothing-to-show states. Sharing one string here
                (it used to reuse the paste-URL placeholder) told an operator
                who had ALREADY registered a host to go paste a URL — the one
                thing they no longer needed to do. */}
            {!selectedHostId && (
              <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {hosts.length === 0 ? t('remote.noHostsHint') : t('remote.selectHostHint')}
              </div>
            )}
            {selectedHostId && (
              <div>
                <Button
                  variant="secondary"
                  className="w-full text-[11px]"
                  disabled={creatingWorkspace}
                  onClick={handleCreateWorkspace}
                >
                  {creatingWorkspace ? t('remote.loading') : t('remote.createWorkspaceHere')}
                </Button>
                {createWorkspaceError && (
                  <div className="text-[10px] mt-1" style={{ color: 'var(--accent-red)' }}>
                    {createWorkspaceError}
                  </div>
                )}
              </div>
            )}
            {selectedHostId && loadingWorkspaces && (
              <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('remote.loading')}</div>
            )}
            {selectedHostId && workspacesError && (
              <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>{workspacesError}</div>
            )}
            {/* A host whose panes are all closed returns an empty list, which
                would otherwise render as a blank pane with no explanation —
                the workspace list is derived from live panes, not a saved
                registry, so "empty" is a normal state that needs saying. */}
            {selectedHostId && !loadingWorkspaces && !workspacesError && workspaces.length === 0 && (
              <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {t('remote.noWorkspaces')}
              </div>
            )}
            {selectedHostId && !loadingWorkspaces && !workspacesError && workspaces.map((ws) => (
              <div
                key={ws.id}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded"
                style={{ background: 'var(--bg-overlay)' }}
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-mono truncate" style={{ color: 'var(--text-main)' }}>
                    {ws.name || ws.id.slice(0, 8)}
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    {t('remote.paneCount', { count: ws.panes.length })}
                    {selectedHost?.allowInput === false && (
                      <span className="ml-2" style={{ color: 'var(--accent)' }}>{t('remote.readOnly')}</span>
                    )}
                  </div>
                </div>
                <Button variant="primary" className="text-[11px] flex-shrink-0" onClick={() => handleAttach(ws)}>
                  {t('remote.attach')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

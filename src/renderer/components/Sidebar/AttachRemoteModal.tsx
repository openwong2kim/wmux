import { useCallback, useEffect, useRef, useState } from 'react';
// Aliased: the Escape-key effect below binds a DOM listener and needs the
// global KeyboardEvent, so React's must not shadow it.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import SegmentedControl from '../ui/SegmentedControl';
import { FOCUS_RING } from '../focusRing';
import { IconPlus, IconX } from '../icons';
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

  const muted = 'm-0 text-[13px] text-[var(--text-sub)]';
  const errorLine = 'ui-row-error !m-0 text-[11px] leading-4';

  // Escape and the backdrop close it (ui/Dialog).
  return (
    <Dialog
      onClose={onClose}
      closeOnBackdrop
      width={640}
      zIndexClassName="z-[var(--z-modal-top)]"
      style={{ maxHeight: '80vh' }}
    >
      <DialogHeader title={t('remote.attachTitle')} />
      <DialogBody className="!p-0 !gap-0 !flex-row mt-4 border-t border-[var(--surface-hairline)]">
        {/* Left: hosts + add-host form */}
        <div className="w-[248px] flex-shrink-0 overflow-y-auto px-4 py-4 flex flex-col gap-4 border-r border-[var(--surface-hairline)]">
          {loadingHosts ? (
            <p className={muted}>{t('remote.loading')}</p>
          ) : hosts.length > 0 ? (
            <div className="ui-group shrink-0">
              {hosts.map((host) => (
                <div
                  key={host.id}
                  className="flex items-center gap-1 pr-1"
                  style={host.id === selectedHostId ? { background: 'var(--surface-fill-hover)' } : undefined}
                >
                  <button
                    type="button"
                    className={`flex-1 min-w-0 text-left px-3 py-2.5 text-[13px] truncate ${FOCUS_RING}`}
                    style={{ color: host.id === selectedHostId ? 'var(--text-main)' : 'var(--text-sub)', fontWeight: host.id === selectedHostId ? 500 : 400 }}
                    aria-pressed={host.id === selectedHostId}
                    onClick={() => selectHost(host.id)}
                  >
                    {host.label}
                  </button>
                  <Button
                    variant="icon"
                    className="w-7 h-7 flex-shrink-0"
                    title={t('remote.removeHost')}
                    aria-label={t('remote.removeHost')}
                    onClick={() => handleRemoveHost(host.id)}
                  >
                    <IconX size={12} />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <SegmentedControl<AddHostMode>
              value={addMode}
              onValueChange={setAddMode}
              ariaLabel={t('remote.addHost')}
              className="w-full [&>button]:flex-1 [&>button]:px-2 [&>button]:whitespace-nowrap [&>button]:text-[12px]"
              options={[
                { value: 'pair', label: t('remote.pairTab') },
                { value: 'url', label: t('remote.urlTab') },
              ]}
            />

            {addMode === 'pair' ? (
              <>
                <p className="m-0 text-[11px] leading-4 text-[var(--text-sub)]">{t('remote.pairHint')}</p>
                <Input
                  type="text"
                  placeholder={t('remote.hostAddressHint')}
                  value={pairOrigin}
                  onChange={(e) => setPairOrigin(e.target.value)}
                  onKeyDown={submitOnEnter(pairDisabled, handlePairHost)}
                  className="text-[12px] font-mono w-full"
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
                  className="text-[12px] font-mono w-full"
                  autoComplete="off"
                  aria-label={t('remote.pairCode')}
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={pairLabel}
                  onChange={(e) => setPairLabel(e.target.value)}
                  onKeyDown={submitOnEnter(pairDisabled, handlePairHost)}
                  className="text-[13px] w-full"
                />
                {/* The one primary once the form can submit; a disabled
                    action is never the primary. */}
                <Button
                  size="md"
                  variant={pairDisabled ? 'secondary' : 'primary'}
                  className="w-full"
                  disabled={pairDisabled}
                  onClick={handlePairHost}
                >
                  {t('remote.pair')}
                </Button>
                {pairError && <p className={errorLine}>{pairError}</p>}
              </>
            ) : (
              <>
                {/* Masked like a password — the URL carries the bearer token. */}
                <Input
                  type="password"
                  placeholder={t('remote.pasteUrlHint')}
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  onKeyDown={submitOnEnter(addDisabled, handleAddHost)}
                  className="text-[12px] font-mono w-full"
                  autoComplete="off"
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  onKeyDown={submitOnEnter(addDisabled, handleAddHost)}
                  className="text-[13px] w-full"
                />
                <Button
                  size="md"
                  variant={addDisabled ? 'secondary' : 'primary'}
                  className="w-full"
                  disabled={addDisabled}
                  onClick={handleAddHost}
                >
                  {t('remote.addHost')}
                </Button>
                {addError && <p className={errorLine}>{addError}</p>}
              </>
            )}
          </div>
        </div>

        {/* Right: the selected host's workspaces */}
        <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {/* Two distinct nothing-to-show states. Sharing one string here
              (it used to reuse the paste-URL placeholder) told an operator
              who had ALREADY registered a host to go paste a URL — the one
              thing they no longer needed to do. */}
          {!selectedHostId && (
            <p className={muted}>
              {hosts.length === 0 ? t('remote.noHostsHint') : t('remote.selectHostHint')}
            </p>
          )}
          {selectedHostId && (
            <div className="flex flex-col gap-1">
              <Button
                size="md"
                variant="secondary"
                className="w-full gap-1.5"
                disabled={creatingWorkspace}
                onClick={handleCreateWorkspace}
              >
                {!creatingWorkspace && <IconPlus size={12} />}
                {creatingWorkspace ? t('remote.loading') : t('remote.createWorkspaceHere')}
              </Button>
              {createWorkspaceError && <p className={errorLine}>{createWorkspaceError}</p>}
            </div>
          )}
          {selectedHostId && loadingWorkspaces && <p className={muted}>{t('remote.loading')}</p>}
          {selectedHostId && workspacesError && <p className="ui-row-error !m-0 text-[13px]">{workspacesError}</p>}
          {/* A host whose panes are all closed returns an empty list, which
              would otherwise render as a blank pane with no explanation —
              the workspace list is derived from live panes, not a saved
              registry, so "empty" is a normal state that needs saying. */}
          {selectedHostId && !loadingWorkspaces && !workspacesError && workspaces.length === 0 && (
            <p className={muted}>{t('remote.noWorkspaces')}</p>
          )}
          {selectedHostId && !loadingWorkspaces && !workspacesError && workspaces.length > 0 && (
            <div className="ui-group shrink-0">
              {workspaces.map((ws) => (
                <div key={ws.id} className="ui-row">
                  <div className="ui-row-text">
                    <p className={`ui-row-title truncate${ws.name ? '' : ' font-mono'}`}>
                      {ws.name || ws.id.slice(0, 8)}
                    </p>
                    <p className="ui-row-detail">
                      {t('remote.paneCount', { count: ws.panes.length })}
                    </p>
                    {selectedHost?.allowInput === false && (
                      <p className="ui-row-detail" style={{ color: 'var(--accent-yellow)' }}>
                        {t('remote.readOnly')}
                      </p>
                    )}
                  </div>
                  <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => handleAttach(ws)}>
                    {t('remote.attach')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}

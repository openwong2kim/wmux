import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
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
  }, [addUrl, addLabel, refreshHosts, t]);

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
  }, [pairOrigin, pairCode, pairLabel, refreshHosts, t]);

  const handleRemoveHost = useCallback(async (hostId: string) => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    try {
      await remote.hostsRemove(hostId);
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
      key: `${host.id}:${ws.id}`,
      hostId: host.id,
      hostLabel: host.label,
      workspaceId: ws.id,
      name: ws.name,
      panes: ws.panes,
    });
    onClose();
  }, [hosts, selectedHostId, attachRemoteWorkspace, onClose]);

  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? null;

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
                  className="text-[11px] font-mono w-full"
                  autoComplete="off"
                  aria-label={t('remote.pairCode')}
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={pairLabel}
                  onChange={(e) => setPairLabel(e.target.value)}
                  className="text-[11px] font-mono w-full"
                />
                <Button
                  variant="secondary"
                  className="w-full text-[11px]"
                  disabled={pairing || !pairOrigin.trim() || !pairCode.trim()}
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
                  className="text-[11px] font-mono w-full"
                  autoComplete="off"
                />
                <Input
                  type="text"
                  placeholder={t('remote.labelOptional')}
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  className="text-[11px] font-mono w-full"
                />
                <Button
                  variant="secondary"
                  className="w-full text-[11px]"
                  disabled={adding || !addUrl.trim()}
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
            {!selectedHostId && (
              <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {t('remote.pasteUrlHint')}
              </div>
            )}
            {selectedHostId && loadingWorkspaces && (
              <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('remote.loading')}</div>
            )}
            {selectedHostId && workspacesError && (
              <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>{workspacesError}</div>
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

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import type { RemoteHostPublic, RemoteWorkspaceSummary } from '../../../shared/remoteHosts';

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

  const [addUrl, setAddUrl] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const refreshHosts = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote) return [];
    const list = await remote.hostsList();
    setHosts(list);
    return list;
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

  const selectHost = useCallback(async (hostId: string) => {
    setSelectedHostId(hostId);
    setWorkspaces([]);
    setWorkspacesError(null);
    setLoadingWorkspaces(true);
    const remote = window.electronAPI?.remote;
    if (!remote) { setLoadingWorkspaces(false); return; }
    const res = await remote.workspacesList(hostId);
    if (res.ok) {
      setWorkspaces(res.workspaces);
      // allowInput may be stale/undefined until a probe runs — a successful
      // workspacesList call IS that probe, so refetch hosts here to pick up
      // the freshened flag before deciding the read-only tag below.
      await refreshHosts();
    } else {
      setWorkspacesError(res.error);
    }
    setLoadingWorkspaces(false);
  }, [refreshHosts]);

  const handleAddHost = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote || !addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    const res = await remote.hostsAdd(addUrl.trim(), addLabel.trim() || undefined);
    setAdding(false);
    if (res.ok) {
      setAddUrl('');
      setAddLabel('');
      await refreshHosts();
    } else {
      setAddError(res.error);
    }
  }, [addUrl, addLabel, refreshHosts]);

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
                  <button
                    key={host.id}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded text-[12px] font-mono truncate"
                    style={{
                      background: host.id === selectedHostId ? 'var(--bg-overlay)' : 'transparent',
                      color: host.id === selectedHostId ? 'var(--text-main)' : 'var(--text-sub)',
                    }}
                    onClick={() => selectHost(host.id)}
                  >
                    {host.label}
                  </button>
                ))
              )}
            </div>

            <div className="border-t my-3" style={{ borderColor: 'var(--bg-overlay)' }} />

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
                placeholder="Label (optional)"
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
                    {ws.panes.length} panes
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

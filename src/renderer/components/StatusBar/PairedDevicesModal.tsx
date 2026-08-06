import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { timeAgo } from '../../utils/timeAgo';
import type { WebDeviceSummary } from '../../../shared/web';

/**
 * The operator's paired-device roster, and the only surface that can revoke one.
 *
 * `daemon.web.deviceRevoke` has existed since M3, but nothing the operator can
 * reach ever called it: the sole revocation available from the UI was `wmux web
 * --stop`, which cuts EVERY device at once. So the per-device credential —
 * durable, no TTL, and worth arbitrary command execution on this machine when
 * the server runs with `--allow-input` — had no individual off switch. This is
 * that switch.
 *
 * Not folded into the Web popover: that is a fixed 288px box already carrying
 * the URL, the QR, the code and the naming field, and a roster of names with
 * timestamps and a two-step destructive control does not fit in it.
 *
 * Reads the roster STORE, so it works while the server is stopped — which is
 * exactly when someone who just stopped sharing wants to check what still holds
 * a credential.
 */
export default function PairedDevicesModal({ onClose }: { onClose: () => void }) {
  const t = useT();

  const [devices, setDevices] = useState<WebDeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  /** deviceId awaiting its second click — see the two-step note below. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.web;
    if (!api?.deviceList) { setLoading(false); return; }
    try {
      const res = await api.deviceList();
      setDevices(res.devices);
      setListError(res.error ?? null);
    } catch (err) {
      setListError((err as Error)?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleRevoke = useCallback(async (deviceId: string) => {
    const api = window.electronAPI?.web;
    if (!api?.deviceRevoke) return;
    setRevoking(deviceId);
    setRevokeError(null);
    try {
      const res = await api.deviceRevoke(deviceId);
      if (!res.ok) {
        setRevokeError(
          res.reason === 'persist-failed' ? t('web.revokePersistFailed')
            : res.reason === 'unavailable' ? t('web.revokeUnavailable')
              : t('web.revokeNotFound'),
        );
      }
    } catch {
      setRevokeError(t('web.revokePersistFailed'));
    } finally {
      setRevoking(null);
      setConfirming(null);
      // Re-list unconditionally. A failed revoke may still have cut the live
      // streams, and a succeeded one leaves a tombstone — either way the
      // roster on screen is stale the moment the call returns.
      await refresh();
    }
  }, [refresh, t]);

  // Live devices first; revoked tombstones sink to the bottom rather than being
  // hidden, so "did that actually work" has an answer on the same screen.
  const ordered = [...devices].sort((a, b) => {
    const ar = a.revokedAt === undefined ? 0 : 1;
    const br = b.revokedAt === undefined ? 0 : 1;
    return ar !== br ? ar - br : b.lastSeenAt - a.lastSeenAt;
  });
  const liveCount = devices.filter((d) => d.revokedAt === undefined).length;

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal-top)] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={t('web.devicesTitle')}
        className="w-[440px] max-h-[80vh] rounded-[7px] shadow-2xl flex flex-col font-sans"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b" style={{ borderColor: 'var(--bg-overlay)' }}>
          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
            {t('web.devicesTitle')}
          </div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-sub)' }}>
            {t('web.devicesSubtitle')}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
          {loading && (
            <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('web.devicesLoading')}</div>
          )}
          {!loading && listError && (
            <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>{listError}</div>
          )}
          {!loading && !listError && ordered.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('web.devicesEmpty')}</div>
          )}

          {ordered.map((d) => {
            const revoked = d.revokedAt !== undefined;
            return (
              <div
                key={d.deviceId}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded"
                style={{ background: 'var(--bg-overlay)', opacity: revoked ? 0.55 : 1 }}
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-mono truncate" style={{ color: 'var(--text-main)' }}>
                    {/* A device paired before naming was required has no name.
                        Say so plainly instead of rendering an empty row. */}
                    {d.name || t('web.deviceUnnamed')}
                    {revoked && (
                      <span className="ml-2 text-[10px]" style={{ color: 'var(--accent-red)' }}>
                        {t('web.deviceRevoked')}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    {revoked
                      ? t('web.deviceRevokedAt', { when: timeAgo(d.revokedAt as number) })
                      : t('web.deviceLastSeen', { when: timeAgo(d.lastSeenAt) })}
                  </div>
                </div>

                {!revoked && (
                  // Two clicks, deliberately. Revocation is permanent — the
                  // record is never un-revoked, and the device returns only by
                  // pairing again — so it does not get a single-click control
                  // sitting next to a list of similar-looking names.
                  // Red tint at rest, solid red only on the confirm (DESIGN.md).
                  <button
                    type="button"
                    disabled={revoking !== null}
                    onClick={() => {
                      if (confirming === d.deviceId) void handleRevoke(d.deviceId);
                      else { setConfirming(d.deviceId); setRevokeError(null); }
                    }}
                    onBlur={() => setConfirming((c) => (c === d.deviceId ? null : c))}
                    className={`flex-shrink-0 rounded-[5px] px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
                    style={
                      confirming === d.deviceId
                        ? { background: 'var(--accent-red)', color: 'var(--bg-base)' }
                        : { background: 'transparent', color: 'var(--accent-red)', border: '1px solid var(--accent-red)' }
                    }
                  >
                    {revoking === d.deviceId
                      ? t('web.revoking')
                      : confirming === d.deviceId
                        ? t('web.revokeConfirm')
                        : t('web.revoke')}
                  </button>
                )}
              </div>
            );
          })}

          {revokeError && (
            <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>{revokeError}</div>
          )}
        </div>

        <div
          className="px-4 py-2.5 border-t flex items-center justify-between"
          style={{ borderColor: 'var(--bg-overlay)' }}
        >
          <span className="text-[10px]" style={{ color: 'var(--text-subtle)' }}>
            {t('web.devicesLiveCount', { count: liveCount })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-[5px] px-3 py-1 text-[11px] transition-colors ${FOCUS_RING}`}
            style={{ background: 'var(--bg-overlay)', color: 'var(--text-main)' }}
          >
            {t('web.devicesClose')}
          </button>
        </div>
      </div>
    </div>
  );
}

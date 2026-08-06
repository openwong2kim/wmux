import { useCallback, useEffect, useRef, useState } from 'react';
// Aliased so the document-level Escape listener below still sees the DOM
// KeyboardEvent rather than React's synthetic one.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { timeAgo } from '../../utils/timeAgo';
import type { WebDeviceListError, WebDeviceSummary } from '../../../shared/web';

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
  const [listError, setListError] = useState<WebDeviceListError | null>(null);
  /** deviceId awaiting its second click — see the two-step note below. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  /** Which device failed, and why. Rendered in ITS row, not as a floating line. */
  const [revokeError, setRevokeError] = useState<{ deviceId: string; message: string } | null>(null);

  // A revoke is in flight and its verdict has nowhere else to land. Guards the
  // setState calls after the await, and — with the close paths below — is why
  // that verdict cannot be dismissed before it is read.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.web;
    // No bridge is a READ FAILURE, not an empty roster. On a credential screen
    // "we could not ask" must never render as "nobody has access" — that is the
    // one wrong answer that reads as reassuring.
    if (!api?.deviceList) {
      if (!mounted.current) return;
      setDevices([]);
      setListError('unavailable');
      setLoading(false);
      return;
    }
    try {
      const res = await api.deviceList();
      if (!mounted.current) return;
      // Clear the rows when the read failed. Keeping the previous list would
      // leave a device the operator just revoked sitting there with a live
      // Revoke button, and the footer counting it as active.
      setDevices(res.error ? [] : res.devices);
      setListError(res.error ?? null);
    } catch {
      if (!mounted.current) return;
      setDevices([]);
      setListError('unavailable');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const revokeInFlight = revoking !== null;

  // Escape is ignored mid-revoke for the same reason the backdrop is: the
  // verdict of a destructive call the operator confirmed must not be
  // dismissable before it has been shown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !revokeInFlight) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, revokeInFlight]);

  const handleRevoke = useCallback(async (deviceId: string) => {
    const api = window.electronAPI?.web;
    if (!api?.deviceRevoke) return;
    setRevoking(deviceId);
    setRevokeError(null);
    try {
      const res = await api.deviceRevoke(deviceId);
      if (!mounted.current) return;
      if (!res.ok) {
        // Each reason makes a DIFFERENT claim about whether this device is off
        // the air right now, so none of them may share copy. `persist-failed`
        // is the only one that earns "its connections were cut", and only when
        // the daemon reported actually cutting some.
        const message =
          res.reason === 'persist-failed'
            ? (res.closed ?? 0) > 0
              ? t('web.revokePersistFailed')
              : t('web.revokePersistFailedNoCut')
            : res.reason === 'unavailable'
              ? t('web.revokeUnavailable')
              : res.reason === 'not-found'
                ? t('web.revokeNotFound')
                : t('web.revokeUnknown');
        setRevokeError({ deviceId, message });
      }
    } catch {
      if (mounted.current) setRevokeError({ deviceId, message: t('web.revokeUnknown') });
    } finally {
      if (mounted.current) {
        setRevoking(null);
        setConfirming(null);
      }
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

  /**
   * Focus lands in the dialog and stays there.
   *
   * The popover that opened this closes on the way, which drops focus to
   * `<body>` — so without this a destructive confirm is on screen while Tab
   * walks the app behind it and a screen reader keeps reading the background.
   */
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);

  const handleTrapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal-top)] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={() => { if (!revokeInFlight) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('web.devicesTitle')}
        className={`w-[440px] max-h-[80vh] rounded-[7px] shadow-2xl flex flex-col font-sans outline-none`}
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleTrapTab}
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
            <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>
              {listError === 'unavailable' ? t('web.devicesUnavailable') : t('web.devicesMalformed')}
            </div>
          )}
          {/* "Nobody is paired" is only ever said after a read that SUCCEEDED. */}
          {!loading && !listError && ordered.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>{t('web.devicesEmpty')}</div>
          )}

          {ordered.map((d) => {
            const revoked = d.revokedAt !== undefined;
            return (
              <div
                key={d.deviceId}
                className="px-3 py-2 rounded"
                style={{ background: 'var(--bg-overlay)', opacity: revoked ? 0.55 : 1 }}
              >
                <div className="flex items-center justify-between gap-3">
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
                {/* In THIS row. A shared line at the foot of the list said
                    nothing about which device failed — and the re-list that
                    follows a failure re-sorts the rows underneath it. */}
                {revokeError?.deviceId === d.deviceId && (
                  <div className="text-[10px] leading-snug pt-1.5" style={{ color: 'var(--accent-red)' }}>
                    {revokeError.message}
                  </div>
                )}
              </div>
            );
          })}

          {/* A failure whose device is gone from the re-listed roster would
              otherwise vanish with it. */}
          {revokeError && !ordered.some((d) => d.deviceId === revokeError.deviceId) && (
            <div className="text-[11px]" style={{ color: 'var(--accent-red)' }}>{revokeError.message}</div>
          )}
        </div>

        <div
          className="px-4 py-2.5 border-t flex items-center justify-between"
          style={{ borderColor: 'var(--bg-overlay)' }}
        >
          {/* A count is a CLAIM about how many devices hold a credential. When
              the read failed there is no such number, and printing "0 active"
              would be the same fail-open the empty-state above avoids. */}
          <span className="text-[10px]" style={{ color: 'var(--text-subtle)' }}>
            {listError ? t('web.devicesCountUnknown') : t('web.devicesLiveCount', { count: liveCount })}
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

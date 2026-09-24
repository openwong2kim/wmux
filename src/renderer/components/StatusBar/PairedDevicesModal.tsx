import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Badge from '../ui/Badge';
import { IconWarning } from '../icons';
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

  /**
   * Is the server's `--allow-input` off?
   *
   * The roster shows each device's own grant, but that grant is a ceiling away
   * from being usable. Without this the screen would show ticked boxes on a
   * server where nothing can type — technically accurate per device, and a
   * complete misread of what is actually possible right now.
   */
  const [serverReadOnly, setServerReadOnly] = useState(false);
  useEffect(() => {
    const api = window.electronAPI?.web;
    if (!api?.status) return;
    void api.status().then((info) => {
      if (mounted.current) setServerReadOnly(info.running === true && info.allowInput !== true);
    }).catch(() => { /* the roster is still worth showing without the ceiling hint */ });
  }, []);

  const revokeInFlight = revoking !== null;

  // Escape, the backdrop and Close are all ignored mid-revoke: the verdict of
  // a destructive call the operator confirmed must not be dismissable before
  // it has been shown.
  const closeIfIdle = () => {
    if (!revokeInFlight) onClose();
  };

  const handleSetInput = useCallback(async (deviceId: string, allowInput: boolean) => {
    const api = window.electronAPI?.web;
    // A silent return leaves the checkbox flipped with nothing having happened.
    if (!api?.deviceSetInput) {
      setRevokeError({ deviceId, message: t('web.revokeUnavailable') });
      return;
    }
    setRevokeError(null);
    try {
      const res = await api.deviceSetInput(deviceId, allowInput);
      if (!mounted.current) return;
      if (!res.ok) {
        setRevokeError({
          deviceId,
          message:
            res.reason === 'persist-failed'
              ? t('web.grantPersistFailed')
              : res.reason === 'unavailable'
                ? t('web.revokeUnavailable')
                : res.reason === 'revoked'
                  ? t('web.grantRevoked')
                  : res.reason === 'not-found'
                    ? t('web.revokeNotFound')
                    : t('web.grantUnknown'),
        });
      }
    } catch {
      if (mounted.current) setRevokeError({ deviceId, message: t('web.grantUnknown') });
    } finally {
      // Re-list either way: the daemon is the authority on what the grant now
      // is, and a failed write may still have taken effect in memory.
      await refresh();
    }
  }, [refresh, t]);

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
   * Focus lands in the dialog and stays there (ui/Dialog traps it).
   *
   * The popover that opened this closes on the way, which drops focus to
   * `<body>` — so without the trap a destructive confirm is on screen while
   * Tab walks the app behind it and a screen reader keeps reading the
   * background. Close takes the initial focus rather than a Revoke button.
   */
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      onClose={closeIfIdle}
      closeOnBackdrop
      width={460}
      zIndexClassName="z-[var(--z-modal-top)]"
      initialFocusRef={closeRef}
      style={{ maxHeight: '80vh' }}
    >
      <DialogHeader title={t('web.devicesTitle')} description={t('web.devicesSubtitle')} />
      <DialogBody className="!gap-3">
        {/* Says the ticked boxes below are dormant, not active. */}
        {serverReadOnly && (
          <div className="ui-notice flex items-start gap-2 px-3.5 py-2.5 text-[11px] leading-4 text-[var(--text-main)]">
            <span className="shrink-0 pt-px" style={{ color: 'var(--accent-yellow)' }} aria-hidden="true">
              <IconWarning size={12} />
            </span>
            {t('web.grantCeilingHint')}
          </div>
        )}
        {loading && <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('web.devicesLoading')}</p>}
        {!loading && listError && (
          <p className="ui-row-error !m-0 text-[13px]">
            {listError === 'unavailable' ? t('web.devicesUnavailable') : t('web.devicesMalformed')}
          </p>
        )}
        {/* "Nobody is paired" is only ever said after a read that SUCCEEDED. */}
        {!loading && !listError && ordered.length === 0 && (
          <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('web.devicesEmpty')}</p>
        )}

        {ordered.length > 0 && (
          <div className="ui-group">
            {ordered.map((d) => {
              const revoked = d.revokedAt !== undefined;
              return (
                <div key={d.deviceId} className="px-3.5 py-2.5" style={{ opacity: revoked ? 0.6 : 1 }}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="ui-row-title flex items-center gap-2 min-w-0">
                        {/* A device paired before naming was required has no
                            name. Say so plainly instead of rendering an empty row. */}
                        <span className="truncate">{d.name || t('web.deviceUnnamed')}</span>
                        {revoked && <Badge tone="danger">{t('web.deviceRevoked')}</Badge>}
                      </p>
                      <p className="ui-row-detail">
                        {revoked
                          ? t('web.deviceRevokedAt', { when: timeAgo(d.revokedAt as number) })
                          : t('web.deviceLastSeen', { when: timeAgo(d.lastSeenAt) })}
                      </p>
                    </div>

                    {!revoked && (
                      // The grant, and the control for it, in one place. A
                      // checkbox rather than a second destructive button: taking
                      // typing away is reversible here, which is exactly what
                      // separates it from the revoke sitting next to it.
                      <label
                        className={`flex-shrink-0 flex items-center gap-2 text-[11px] cursor-pointer text-[var(--text-sub)] ${
                          serverReadOnly ? 'opacity-50' : ''
                        }`}
                        title={serverReadOnly ? t('web.grantCeilingHint') : undefined}
                      >
                        <Checkbox
                          checked={d.allowInput}
                          onCheckedChange={(next) => { void handleSetInput(d.deviceId, next); }}
                          aria-label={t('web.grantLabel')}
                        />
                        {t('web.grantLabel')}
                      </label>
                    )}

                    {!revoked && (
                      // Two clicks, deliberately. Revocation is permanent — the
                      // record is never un-revoked, and the device returns only by
                      // pairing again — so it does not get a single-click control
                      // sitting next to a list of similar-looking names.
                      // Red tint at rest, solid red only on the confirm (DESIGN.md).
                      <Button
                        size="sm"
                        variant={confirming === d.deviceId ? 'danger' : 'destructive'}
                        className="flex-shrink-0"
                        disabled={revoking !== null}
                        onClick={() => {
                          if (confirming === d.deviceId) void handleRevoke(d.deviceId);
                          else { setConfirming(d.deviceId); setRevokeError(null); }
                        }}
                        onBlur={() => setConfirming((c) => (c === d.deviceId ? null : c))}
                      >
                        {revoking === d.deviceId
                          ? t('web.revoking')
                          : confirming === d.deviceId
                            ? t('web.revokeConfirm')
                            : t('web.revoke')}
                      </Button>
                    )}
                  </div>
                  {/* In THIS row. A shared line at the foot of the list said
                      nothing about which device failed — and the re-list that
                      follows a failure re-sorts the rows underneath it. */}
                  {revokeError?.deviceId === d.deviceId && (
                    <p className="ui-row-error">{revokeError.message}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* A failure whose device is gone from the re-listed roster would
            otherwise vanish with it. */}
        {revokeError && !ordered.some((d) => d.deviceId === revokeError.deviceId) && (
          <p className="ui-row-error !m-0 text-[13px]">{revokeError.message}</p>
        )}
      </DialogBody>

      <DialogFooter>
        {/* A count is a CLAIM about how many devices hold a credential. When
            the read failed there is no such number, and printing "0 active"
            would be the same fail-open the empty-state above avoids. */}
        <span className="mr-auto text-[11px] text-[var(--text-sub)]">
          {listError ? t('web.devicesCountUnknown') : t('web.devicesLiveCount', { count: liveCount })}
        </span>
        {/* Same rule as Escape and the backdrop: a destructive call the
            operator confirmed must not be dismissable before its verdict has
            been shown. Leaving this one live made the other two decorative. */}
        <Button ref={closeRef} size="md" variant="secondary" onClick={onClose} disabled={revokeInFlight}>
          {t('web.devicesClose')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

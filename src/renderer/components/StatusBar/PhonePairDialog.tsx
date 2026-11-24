import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildQrPath } from './qrPath';
import { FOCUS_RING } from '../focusRing';
import { IconCheck, IconChevron, IconWarning } from '../icons';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import PairingScope from '../PcRail/PairingScope';
import { TailscaleProblemFix } from '../Remote/TailscaleChecklist';
import { useT } from '../../hooks/useT';
import {
  DEVICE_NAME_MAX,
  PhonePairCode,
  splitLinkedLine,
  uniqueDeviceName,
  webPairUrl,
  webQrPayload,
  type CopyTarget,
} from './WebToggle';
import {
  webComputerPairOrigin,
  type WebDeviceSummary,
  type WebDiagnosis,
  type WebGrantArgs,
  type WebTerminalInfo,
} from '../../../shared/web';

/**
 * Pair a phone, in one modal: whether this computer can serve HTTPS, the
 * phone's name and what it may do, then its QR, then the phone arriving.
 * Everything goes through the same web.* calls the Remote hub uses.
 *
 * Mounted once (AppLayout) and opened by a store request, never per button:
 * the daemon holds one pairing code, so two dialogs would rotate each other's.
 */

export type PairStep = 'form' | 'qr' | 'done';

/** How often the pairing is re-read while the QR is on screen. */
const PAIR_POLL_MS = 2_000;

/**
 * Ticks a consumed code may go without its device showing on the roster
 * before the dialog calls it lapsed: the daemon burns the code BEFORE it
 * writes the device, so one read can land in between.
 */
const MISSING_DEVICE_TICKS = 3;

/** A steel text link (DESIGN.md: steel is for focus rings and links). */
const LINK = `text-[11px] leading-4 text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`;

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Whether this computer can pair a phone now.
 *
 * `shared` — a server is already up on an HTTPS address another device can
 *   reach (a tailnet front or native TLS), so there is nothing to set up.
 * `ready` — nothing is running and Tailscale can put a front up.
 * `needs-restart` — a server is running WITHOUT such an address. Restarting it
 *   is the fix, but every viewer drops, so the dialog points at Phone access
 *   settings' Stop instead of doing it behind the operator's back.
 * `tailscale` — Tailscale cannot front it; the diagnosis says why.
 */
export type Readiness = 'shared' | 'ready' | 'needs-restart' | 'tailscale';

export function pairReadiness(d: WebDiagnosis): Readiness {
  if (d.web.running) return webComputerPairOrigin(d.web) ? 'shared' : 'needs-restart';
  return d.tailscale.ok ? 'ready' : 'tailscale';
}

/** The pairing this dialog started, for the watcher and for putting grants back. */
export interface PairSession {
  /** The name the code registers — also how the new device is recognised. */
  name: string;
  /** The per-device grant the code was minted with. New codes reuse it. */
  remote: boolean;
  /** When the code was minted; a matching device must be newer than this. */
  mintedAt: number;
  /** Server-wide grants this pairing changed, with the values to put back. */
  restore: WebGrantArgs;
}

/** Whether `info` still holds the live phone code for `name`. */
export function codeIsLive(info: WebTerminalInfo, name: string): boolean {
  return (
    info.running === true &&
    typeof info.pairCode === 'string' &&
    info.pairCode !== '' &&
    info.pendingDeviceName === name &&
    info.pendingPairFlow !== 'computer'
  );
}

/**
 * The device this pairing's code registered, or null.
 *
 * Keyed on the CODE, not on a roster diff: once the code is consumed, the
 * device it minted carries the pending name and was created after the mint.
 * An older device with the same name is not it.
 */
export function findPairedDevice(
  devices: readonly WebDeviceSummary[],
  name: string,
  since: number,
): WebDeviceSummary | null {
  const matches = devices
    .filter((d) => d.revokedAt === undefined && d.name === name && d.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches[0] ?? null;
}

/** A server-wide change the chosen access makes, and who else it reaches. */
export interface SharedImpact {
  key: 'web.wizardInputRaiseWarn';
  /** Other paired devices it reaches; null when the roster could not be read. */
  count: number | null;
}

/**
 * What Can type changes for EVERYONE, not just this phone. Input is a
 * server-wide ceiling, so raising it lets every device whose own grant is on
 * (records written before per-device grants count as on) — and anyone with
 * the full access link — type. The dialog never touches the upload grant.
 */
export function sharedImpacts(
  info: WebTerminalInfo,
  roster: readonly WebDeviceSummary[] | null,
  remote: boolean,
): SharedImpact[] {
  if (!remote || (info.running === true && info.allowInput === true)) return [];
  const live = roster ? roster.filter((d) => d.revokedAt === undefined) : null;
  const typing = live ? live.filter((d) => d.allowInput).length : null;
  // Running: the token link can already be open somewhere, so say so even
  // with no paired device.
  return typing !== 0 || info.running === true ? [{ key: 'web.wizardInputRaiseWarn', count: typing }] : [];
}

// ─── Presentational view ───────────────────────────────────────────────────

export interface PhonePairViewProps {
  step: PairStep;
  info: WebTerminalInfo;
  /** Null while the check runs. */
  readiness: Readiness | null;
  diagnosis: WebDiagnosis | null;
  busy: boolean;
  remote: boolean;
  name: string;
  /** Why the last start / grant change / code mint failed, when it did. */
  errorLines: string[];
  qr: ReturnType<typeof buildQrPath>;
  copied: CopyTarget;
  /** The pairing on screen (qr) or just finished (done). */
  pairedName: string;
  pairedRemote: boolean;
  /** Server-wide effects of the current choice. */
  impacts: readonly SharedImpact[];
  acknowledged: boolean;
  scopeOpen: boolean;
  /** A one-line note carried back to the form (a pairing that lapsed). */
  notice: string | null;
  onToggleAcknowledged: () => void;
  onToggleScope: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onRemoteChange: (remote: boolean) => void;
  onNameChange: (value: string) => void;
  onPair: () => void;
  onClose: () => void;
  onCancelPairing: () => void;
  onNewPairCode: () => void;
  onCopyPairUrl: () => void;
  onCopyPairCode: () => void;
  onOpenLink: (url: string) => void;
  onAnother: () => void;
  t: (key: string) => string;
}

function Lines({ lines, onOpenLink }: { lines: string[]; onOpenLink: (url: string) => void }) {
  return (
    <div className="ui-notice flex gap-2 px-3 py-2.5" data-testid="pair-problem">
      <span className="mt-0.5 shrink-0 text-[var(--accent-yellow)]" aria-hidden="true">
        <IconWarning size={12} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {lines.map((line, i) => {
          const { before, url, after } = splitLinkedLine(line);
          return (
            <span key={i} className="ui-note break-words">
              {before}
              {url ? (
                <button type="button" onClick={() => onOpenLink(url)} aria-label={url} className={LINK}>
                  {url}
                </button>
              ) : null}
              {after}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Whether the form's Pair can run with what is on screen. */
export function canPair(p: Pick<PhonePairViewProps, 'readiness' | 'name' | 'busy' | 'impacts' | 'acknowledged'>): boolean {
  const ready = p.readiness === 'ready' || p.readiness === 'shared';
  return ready && p.name.trim().length > 0 && !p.busy && (p.impacts.length === 0 || p.acknowledged);
}

/** The dialog's body and footer for one step. The header is the container's. */
export function PhonePairView(p: PhonePairViewProps) {
  const { t } = p;
  const access = t(p.pairedRemote ? 'web.wizardRemoteControl' : 'web.wizardViewOnly');

  if (p.step === 'qr') {
    const refusal = p.info.pairRefusal;
    return (
      <>
        <DialogBody className="flex flex-col gap-3">
          {refusal ? (
            // Replaces the code: a code beside "pairing is unavailable" is
            // still one someone will read onto a phone.
            <div className="flex flex-col gap-1.5" data-testid="pair-refusal">
              <p className="ui-note text-[var(--text-main)]">
                {refusal.reason === 'no-front' ? t('web.refusalNoFront') : t('web.refusalInsecure')}
              </p>
              <p className="ui-note" title={refusal.detail}>
                {refusal.reason === 'no-front' ? t('web.refusalNoFrontFix') : t('web.refusalInsecureFix')}
              </p>
              <Button size="sm" onClick={p.onOpenSettings} className="self-start">
                {t('web.phonePairingSettings')}
              </Button>
            </div>
          ) : codeIsLive(p.info, p.pairedName) ? (
            <PhonePairCode
              info={p.info}
              qr={p.qr}
              busy={p.busy}
              copied={p.copied}
              onCopyPairUrl={p.onCopyPairUrl}
              onCopyPairCode={p.onCopyPairCode}
              onNewPairCode={p.onNewPairCode}
              t={t}
            />
          ) : (
            // The named code is no longer live: the watcher is finding out
            // whether it became this phone or lapsed. Never show a code that
            // registers nobody meanwhile.
            <p className="ui-note">{t('web.devicesLoading')}</p>
          )}
          {p.errorLines.length > 0 ? <Lines lines={p.errorLines} onOpenLink={p.onOpenLink} /> : null}
          <p className="ui-note flex items-center gap-1.5" role="status" data-testid="pair-waiting">
            <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--accent)]" />
            <span>{t('web.phonePairingWaiting').replace('{access}', access)}</span>
          </p>
        </DialogBody>
        <DialogFooter>
          <Button size="md" onClick={p.onCancelPairing} disabled={p.busy} data-testid="pair-cancel-pairing">
            {t('web.cancelPairing')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (p.step === 'done') {
    return (
      <>
        <DialogBody className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-main)]" role="status" data-testid="pair-connected">
            <span className="shrink-0 text-[var(--accent-green)]" aria-hidden="true">
              <IconCheck size={14} />
            </span>
            <span>{t('web.phonePairingConnected').replace('{name}', p.pairedName || t('web.deviceUnnamed')).replace('{access}', access)}</span>
          </p>
          <p className="ui-note">{t('web.phonePairingChangeLater')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="md" onClick={p.onAnother}>
            {t('web.phonePairingAnother')}
          </Button>
          <Button variant="primary" size="md" onClick={p.onClose}>
            {t('web.wizardDone')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  // form
  const r = p.readiness;
  const go = canPair(p);
  const problem = p.diagnosis && !p.diagnosis.tailscale.ok ? p.diagnosis.tailscale : null;
  return (
    <>
      <DialogBody className="flex flex-col gap-3">
        {/* Readiness, one line; a problem carries its one fix on that line. */}
        {r === null ? (
          <p className="ui-note" role="status" data-testid="pair-readiness">
            {t('web.wizardChecking')}
          </p>
        ) : r === 'ready' || r === 'shared' ? (
          <p className="ui-note flex items-center gap-1.5" role="status" data-testid="pair-readiness">
            <span className="shrink-0 text-[var(--accent-green)]" aria-hidden="true">
              <IconCheck size={12} />
            </span>
            <span>{t(r === 'shared' ? 'web.wizardAlreadySharing' : 'web.wizardReady')}</span>
          </p>
        ) : r === 'needs-restart' ? (
          <div className="flex flex-col gap-1.5" data-testid="pair-readiness">
            <p className="ui-note" role="status">{t('web.wizardNeedsRestart')}</p>
            <Button size="sm" onClick={p.onOpenSettings} className="self-start">
              {t('web.phonePairingSettings')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="pair-readiness">
            <Lines
              lines={problem && problem.lines.length > 0 ? problem.lines : [t('web.wizardCheckFailed')]}
              onOpenLink={p.onOpenLink}
            />
            <div className="flex items-center gap-2">
              {/* The one fix, a click away: open Tailscale or its download page. */}
              <TailscaleProblemFix problem={problem?.problem} testId="pair" />
              <Button variant="ghost" size="sm" onClick={p.onRetry}>
                {t('web.wizardRetry')}
              </Button>
            </div>
          </div>
        )}
        {/* Running behind a tailnet front while tailscale itself reports a
            problem: the address may reach nothing, so say it, don't bury it. */}
        {r === 'shared' && p.diagnosis && p.diagnosis.web.tailscale === true && problem ? (
          <>
            <p className="ui-note">{t('web.wizardTailscaleWarn')}</p>
            <Lines lines={problem.lines} onOpenLink={p.onOpenLink} />
            <TailscaleProblemFix problem={problem.problem} testId="pair-shared" />
          </>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="ui-note">{t('web.phonePairingName')}</span>
          <Input
            type="text"
            value={p.name}
            onChange={(e) => p.onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && go) p.onPair();
            }}
            placeholder={t('web.namePlaceholder')}
            maxLength={DEVICE_NAME_MAX}
            disabled={p.busy}
            className="w-full text-[13px]"
            data-testid="pair-name"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="ui-note">{t('web.phonePairingAccess')}</span>
          <SegmentedControl<'view' | 'remote'>
            value={p.remote ? 'remote' : 'view'}
            options={[
              { value: 'view', label: t('web.wizardViewOnly'), disabled: p.busy },
              { value: 'remote', label: t('web.wizardRemoteControl'), disabled: p.busy },
            ]}
            onValueChange={(v) => p.onRemoteChange(v === 'remote')}
            ariaLabel={t('web.phonePairingAccess')}
            data-testid="pair-access"
          />
          <p className="ui-note">{t(p.remote ? 'web.wizardRemoteHint' : 'web.wizardViewOnlyHint')}</p>
        </div>
        {p.impacts.length > 0 ? (
          <div className="ui-notice flex flex-col gap-2 px-3 py-2.5" data-testid="pair-impacts">
            {p.impacts.map((impact) => (
              <p key={impact.key} className="ui-note flex gap-1.5">
                <span className="mt-0.5 shrink-0 text-[var(--accent-yellow)]" aria-hidden="true">
                  <IconWarning size={11} />
                </span>
                <span>{t(impact.key).replace('{count}', impact.count === null ? '?' : String(impact.count))}</span>
              </p>
            ))}
            <Field label={t('web.wizardConfirmShared')}>
              <Checkbox checked={p.acknowledged} disabled={p.busy} onCheckedChange={() => p.onToggleAcknowledged()} />
            </Field>
          </div>
        ) : null}
        {/* What a paired phone reaches, folded: the long paragraph the hub
            used to show above every pairing. */}
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={p.scopeOpen}
            onClick={p.onToggleScope}
            className={`ui-note flex items-center gap-1 self-start rounded-[6px] ${FOCUS_RING}`}
            data-testid="pair-scope-toggle"
          >
            <span aria-hidden="true" className="inline-flex transition-transform" style={{ transform: p.scopeOpen ? 'rotate(90deg)' : undefined }}>
              <IconChevron size={11} />
            </span>
            {t('web.phonePairingScope')}
          </button>
          {p.scopeOpen ? <PairingScope className="pl-4" /> : null}
        </div>
        {p.notice ? <p className="ui-note">{p.notice}</p> : null}
        {p.errorLines.length > 0 ? <Lines lines={p.errorLines} onOpenLink={p.onOpenLink} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" onClick={p.onClose} disabled={p.busy}>
          {t('web.cancel')}
        </Button>
        {/* Blocked or in flight it is not the primary: DESIGN.md keeps the
            warm fill off disabled and running actions. */}
        <Button variant={go ? 'primary' : 'secondary'} size="md" onClick={p.onPair} disabled={!go} data-testid="pair-submit">
          {p.busy ? t('web.wizardPreparing') : t('web.phonePairingPair')}
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Stateful dialog ───────────────────────────────────────────────────────

type WebApi = NonNullable<Window['electronAPI']['web']>;

export interface PhonePairDialogProps {
  onClose: () => void;
  /** Close this and open Phone access settings (the hub). */
  onOpenSettings: () => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function PhonePairDialog({ onClose, onOpenSettings }: PhonePairDialogProps) {
  const t = useT();
  const api = (typeof window === 'undefined' ? undefined : window.electronAPI?.web) as WebApi | undefined;
  const [step, setStep] = useState<PairStep>('form');
  const [info, setInfo] = useState<WebTerminalInfo>({ running: false });
  const [diagnosis, setDiagnosis] = useState<WebDiagnosis | null>(null);
  /** No diagnose bridge: readiness is read from status alone, and a start failure says why. */
  const [statusOnly, setStatusOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState(false);
  const [name, setName] = useState('');
  const nameTouched = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [roster, setRoster] = useState<WebDeviceSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorLines, setErrorLines] = useState<string[]>([]);
  const [paired, setPaired] = useState<{ name: string; remote: boolean }>({ name: '', remote: false });
  const [copied, setCopied] = useState<CopyTarget>(null);

  /** The pairing in progress. A ref: every close path reads it. */
  const session = useRef<PairSession | null>(null);
  /** Set once the dialog is going away, so a mint that lands after it is undone. */
  const closed = useRef(false);

  const readRoster = useCallback(async (): Promise<WebDeviceSummary[] | null> => {
    if (!api?.deviceList) return null;
    try {
      const res = await api.deviceList();
      return res.error ? null : res.devices;
    } catch {
      return null;
    }
  }, [api]);

  const checking = useRef(false);
  const runCheck = useCallback(async () => {
    if (!api || checking.current) return;
    checking.current = true;
    setDiagnosis(null);
    setStatusOnly(false);
    try {
      if (typeof api.diagnose === 'function') {
        const d = await api.diagnose();
        if (closed.current) return;
        setDiagnosis(d);
        setInfo(d.web);
      } else {
        const s = await api.status();
        if (closed.current) return;
        setInfo(s);
        setStatusOnly(true);
      }
    } catch {
      // The bridge itself failed: say "cannot tell" rather than "ready".
      if (!closed.current) setDiagnosis({ tailscale: { ok: false, problem: 'status-unreadable', lines: [] }, web: { running: false } });
    } finally {
      checking.current = false;
    }
  }, [api]);

  // On open: the check, and the roster (the default name, and who else Can type reaches).
  useEffect(() => {
    void runCheck();
    let live = true;
    void readRoster().then((r) => {
      if (!live) return;
      setRoster(r);
      if (!nameTouched.current) setName(uniqueDeviceName(t('web.connectPhoneDefaultName'), r));
    });
    return () => {
      live = false;
    };
    // Once per open.
  }, []);

  // The check's Tailscale answer with the server as it is NOW: the dialog
  // itself may have started it since.
  const readiness: Readiness | null = diagnosis
    ? pairReadiness({ tailscale: diagnosis.tailscale, web: info })
    : statusOnly
      ? info.running
        ? webComputerPairOrigin(info) ? 'shared' : 'needs-restart'
        : 'ready'
      : null;

  const impacts = useMemo(() => sharedImpacts(info, roster, remote), [info, roster, remote]);
  // A confirmation covers one attempt with the choice it was given for.
  useEffect(() => setAcknowledged(false), [remote, step]);

  /** Put back what this pairing changed server-wide. Best effort. */
  const restoreGrants = useCallback(
    async (restore: WebGrantArgs) => {
      if (!api?.setGrants || Object.keys(restore).length === 0) return;
      try {
        const next = await api.setGrants(restore);
        if (!closed.current) setInfo(next);
      } catch {
        /* the hub still shows the live values; nothing else to do here */
      }
    },
    [api],
  );

  /**
   * End the pairing: burn the code, then put back what it raised — unless the
   * code's phone arrived after all (redeemed between two watcher reads, or
   * just as the dialog closed): that phone was paired with this access, and
   * lowering input now would take it away from it.
   */
  const abandon = useCallback(
    async (cancelCode: boolean) => {
      const s = session.current;
      session.current = null;
      if (cancelCode && api?.pairCancel) {
        try {
          const next = await api.pairCancel();
          if (!closed.current) setInfo(next);
        } catch {
          /* restoring still matters more than the code */
        }
      }
      if (!s || Object.keys(s.restore).length === 0) return;
      const list = await readRoster();
      if (list && findPairedDevice(list, s.name, s.mintedAt)) return;
      await restoreGrants(s.restore);
    },
    [api, readRoster, restoreGrants],
  );

  // However the dialog goes away (×, Escape, Cancel pairing, Done, the host
  // unmounting), a live code is burned and a raised input put back. Mount
  // resets the flag: StrictMode runs this cleanup once before the real mount.
  const abandonRef = useRef(abandon);
  abandonRef.current = abandon;
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (session.current) void abandonRef.current(true);
    };
  }, []);

  const close = useCallback(() => {
    closed.current = true;
    if (session.current) void abandon(true);
    onClose();
  }, [abandon, onClose]);

  /**
   * Start if needed, raise input for Can type, mint. Re-reads status first:
   * the screen may be a poll behind, and a raise that would now reach other
   * devices is shown and confirmed, never done silently.
   */
  const handlePair = useCallback(async () => {
    const trimmed = name.trim();
    if (!api || !trimmed) return;
    setBusy(true);
    setErrorLines([]);
    setNotice(null);
    const restore: WebGrantArgs = {};
    let minted = false;
    try {
      let current = await api.status();
      setInfo(current);
      // One code slot: a computer link Connect a PC… handed out would stop
      // pairing anything if a phone code replaced it.
      if (current.running && current.pairCode && current.pendingPairFlow === 'computer') {
        setErrorLines([t('web.phonePairingBusy')]);
        return;
      }
      const wantRemote = remote;
      if (wantRemote && !acknowledged && sharedImpacts(current, roster, true).length > 0) return;
      if (!current.running) {
        // Only input is chosen here; the other grants are the daemon's, like
        // the hub's Start: inherited from an enabled record, off after a stop.
        current = await api.start({ tailscale: true, allowInput: wantRemote });
        setInfo(current);
        if (!current.running) {
          setErrorLines(current.transportError?.lines ?? (current.error ? [current.error] : []));
          return;
        }
        if (wantRemote) restore.allowInput = false;
      } else if (wantRemote && current.allowInput !== true && api.setGrants) {
        // Raise input, never lower it: view only for THIS phone must not
        // take typing away from devices already paired.
        current = await api.setGrants({ allowInput: true });
        setInfo(current);
        restore.allowInput = false;
        if (current.error) {
          setErrorLines([current.error]);
          return;
        }
      }
      const mintedAt = Date.now();
      const res = await api.pairStart(trimmed, wantRemote, 'phone');
      setInfo(res);
      if (res.pairStartError || !codeIsLive(res, trimmed)) {
        setErrorLines([res.pairStartError ?? res.error ?? t('web.wizardCheckFailed')]);
        return;
      }
      session.current = { name: trimmed, remote: wantRemote, mintedAt, restore };
      minted = true;
      if (closed.current) {
        // Closed while the code was being minted: nobody will scan it.
        void abandon(true);
        return;
      }
      setPaired({ name: trimmed, remote: wantRemote });
      setStep('qr');
    } catch (err) {
      setErrorLines([errorText(err)]);
    } finally {
      if (!minted) await restoreGrants(restore);
      if (!closed.current) setBusy(false);
    }
  }, [api, name, remote, acknowledged, roster, restoreGrants, abandon, t]);

  // While the QR is up, follow the CODE: as long as the daemon still holds it
  // under this name, keep waiting; once it is gone, the device it minted is
  // the phone — or, if none shows up, the pairing lapsed and whatever was
  // raised goes back.
  const missing = useRef(0);
  useEffect(() => {
    if (step !== 'qr' || !api) return;
    let stopped = false;
    missing.current = 0;
    const tick = async () => {
      const s = session.current;
      if (!s) return;
      let status: WebTerminalInfo;
      try {
        status = await api.status();
      } catch {
        return;
      }
      if (stopped) return;
      setInfo(status);
      if (codeIsLive(status, s.name)) return;
      const list = await readRoster();
      if (stopped || session.current !== s) return;
      const device = list ? findPairedDevice(list, s.name, s.mintedAt) : null;
      if (device && list) {
        session.current = null;
        setRoster(list);
        setStep('done');
        return;
      }
      if (list === null || ++missing.current < MISSING_DEVICE_TICKS) return;
      await abandon(false);
      if (stopped) return;
      setNotice(t('web.wizardCodeLapsed'));
      setStep('form');
    };
    void tick();
    const timer = setInterval(() => void tick(), PAIR_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, api, readRoster, abandon, t]);

  // Same name, same CONFIRMED grant.
  const handleNewPairCode = useCallback(async () => {
    const s = session.current;
    if (!api || !s) return;
    setBusy(true);
    setErrorLines([]);
    try {
      const res = await api.pairStart(s.name, s.remote, 'phone');
      setInfo(res);
      if (res.pairStartError) setErrorLines([res.pairStartError]);
    } catch (err) {
      setErrorLines([errorText(err)]);
    } finally {
      setBusy(false);
    }
  }, [api]);

  const handleCancelPairing = useCallback(async () => {
    setBusy(true);
    setErrorLines([]);
    try {
      await abandon(true);
      setStep('form');
    } finally {
      setBusy(false);
    }
  }, [abandon]);

  const copyValue = useCallback(async (target: Exclude<CopyTarget, null>, value: string) => {
    if (!value) return;
    try {
      await window.clipboardAPI?.writeText(value);
      setCopied(target);
      setTimeout(() => setCopied((c) => (c === target ? null : c)), 1500);
    } catch {
      /* clipboard lock/size error — every value stays select-all for manual copy */
    }
  }, []);

  const handleOpenLink = useCallback((url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    void window.electronAPI?.shell?.openExternal?.(url);
  }, []);

  const qrPayload = webQrPayload(info);
  const qr = useMemo(() => buildQrPath(qrPayload), [qrPayload]);

  const title = step === 'qr' ? t('web.phonePairingTitleFor').replace('{name}', paired.name) : t('web.phonePairingTitle');

  return (
    <Dialog onClose={close} width={420} data-testid="phone-pair-dialog">
      <DialogHeader title={title} closeLabel={t('web.cancel')} closeTestId="pair-close" />
      <PhonePairView
        step={step}
        info={info}
        readiness={readiness}
        diagnosis={diagnosis}
        busy={busy}
        remote={remote}
        name={name}
        errorLines={errorLines}
        qr={qr}
        copied={copied}
        pairedName={paired.name}
        pairedRemote={paired.remote}
        impacts={impacts}
        acknowledged={acknowledged}
        scopeOpen={scopeOpen}
        notice={notice}
        onToggleAcknowledged={() => setAcknowledged((v) => !v)}
        onToggleScope={() => setScopeOpen((v) => !v)}
        onRetry={() => void runCheck()}
        onOpenSettings={() => {
          close();
          onOpenSettings();
        }}
        onRemoteChange={setRemote}
        onNameChange={(v) => {
          nameTouched.current = true;
          setName(v.slice(0, DEVICE_NAME_MAX));
        }}
        onPair={() => void handlePair()}
        onClose={close}
        onCancelPairing={() => void handleCancelPairing()}
        onNewPairCode={() => void handleNewPairCode()}
        onCopyPairUrl={() => void copyValue('pairUrl', webPairUrl(info))}
        onCopyPairCode={() => void copyValue('pairCode', info.pairCode ?? '')}
        onOpenLink={handleOpenLink}
        onAnother={() => {
          // A fresh decision for the next phone: nothing carries over.
          nameTouched.current = false;
          setName(uniqueDeviceName(t('web.connectPhoneDefaultName'), roster));
          setRemote(false);
          setNotice(null);
          setErrorLines([]);
          setStep('form');
          void runCheck();
        }}
        t={t}
      />
    </Dialog>
  );
}

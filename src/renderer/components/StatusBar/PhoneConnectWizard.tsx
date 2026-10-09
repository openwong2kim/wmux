import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildQrPath } from './qrPath';
import { FOCUS_RING } from '../focusRing';
import { IconCheck, IconComputer, IconPhone, IconRemoteDevices, IconWarning } from '../icons';
import { PopoverSection } from '../ui/Popover';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import {
  DEVICE_NAME_MAX,
  PhonePairCode,
  splitLinkedLine,
  uniqueDeviceName,
  webQrPayload,
  type CopyTarget,
} from './WebToggle';
import {
  webComputerPairOrigin,
  type WebDeviceSummary,
  type WebDiagnosis,
  type WebGrantArgs,
  type WebStartArgs,
  type WebTerminalInfo,
} from '../../../shared/web';

/**
 * "Connect a phone" as four steps inside the Remote popover: check that this
 * computer can serve HTTPS, choose what the phone may do, scan, and see it
 * arrive. Everything it does goes through the same web.* calls the hub uses;
 * it only puts them in an order a first-time user can follow.
 */

export type WizardStep = 'check' | 'permissions' | 'qr' | 'done';
const STEP_NUMBER: Record<WizardStep, number> = { check: 1, permissions: 2, qr: 3, done: 4 };

/** How often the pairing is re-read while the QR is on screen. */
const PAIR_POLL_MS = 2_000;

/**
 * Ticks a consumed code may go without its device showing on the roster
 * before the wizard calls it lapsed: the daemon burns the code BEFORE it
 * writes the device, so one read can land in between.
 */
const MISSING_DEVICE_TICKS = 3;

/** A steel text link (DESIGN.md: steel is for focus rings and links). */
const LINK = `text-[11px] leading-4 text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`;

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * What step 1 concludes.
 *
 * `shared` — a server is already up on an HTTPS address another device can
 *   reach (a tailnet front or native TLS), so there is nothing to set up.
 * `ready` — nothing is running and Tailscale can put a front up.
 * `needs-restart` — a server is running WITHOUT such an address. Restarting it
 *   is the fix, but Stop revokes nothing only from the operator's point of
 *   view — every viewer drops — so the wizard sends them to the hub's Stop
 *   instead of doing it behind their back.
 * `tailscale` — Tailscale cannot front it; the diagnosis says why.
 */
export type Readiness = 'shared' | 'ready' | 'needs-restart' | 'tailscale';

export function wizardReadiness(d: WebDiagnosis): Readiness {
  if (d.web.running) return webComputerPairOrigin(d.web) ? 'shared' : 'needs-restart';
  return d.tailscale.ok ? 'ready' : 'tailscale';
}

/**
 * The pairing this wizard started. Held by the popover (a ref that outlives
 * this component) so closing and reopening the popover mid-scan picks the
 * same pairing back up instead of stranding it.
 */
export interface WizardSession {
  /** The name the code registers — also how the new device is recognised. */
  name: string;
  /** The per-device grant the code was minted with. New codes reuse it. */
  remote: boolean;
  /** When the code was minted; a matching device must be newer than this. */
  mintedAt: number;
  /**
   * Server-wide grants the wizard changed for this pairing, with the values
   * to put back if it is abandoned before a phone connects.
   */
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

/** A server-wide change the chosen permissions make, and who else it reaches. */
export interface SharedImpact {
  key: 'web.wizardInputRaiseWarn' | 'web.wizardUploadOnWarn' | 'web.wizardUploadOffWarn';
  /** Other paired devices it reaches; null when the roster could not be read. */
  count: number | null;
}

/**
 * What Remote control and the upload box change for EVERYONE, not just this
 * phone. Input and upload are server-wide ceilings, so raising input lets
 * every device whose own grant is on (records written before per-device
 * grants count as on) — and anyone with the full access link — type, and the
 * upload box is shared by every paired device in both directions.
 */
export function sharedImpacts(
  info: WebTerminalInfo,
  roster: readonly WebDeviceSummary[] | null,
  remote: boolean,
  upload: boolean,
): SharedImpact[] {
  const live = roster ? roster.filter((d) => d.revokedAt === undefined) : null;
  const out: SharedImpact[] = [];
  const inputOn = info.running === true && info.allowInput === true;
  if (remote && !inputOn) {
    const typing = live ? live.filter((d) => d.allowInput).length : null;
    // Running: the token link can already be open somewhere, so say so even
    // with no paired device.
    if (typing !== 0 || info.running === true) out.push({ key: 'web.wizardInputRaiseWarn', count: typing });
  }
  const uploadOn = info.running === true && info.allowUpload === true;
  if (upload !== uploadOn && (live === null || live.length > 0)) {
    out.push({ key: upload ? 'web.wizardUploadOnWarn' : 'web.wizardUploadOffWarn', count: live ? live.length : null });
  }
  return out;
}

// ─── Presentational view ───────────────────────────────────────────────────

export interface PhoneWizardViewProps {
  step: WizardStep;
  info: WebTerminalInfo;
  diagnosis: WebDiagnosis | null;
  busy: boolean;
  remote: boolean;
  /** The upload checkbox as shown (the server's value until touched). */
  upload: boolean;
  name: string;
  /** Why the last start / grant change / code mint failed, when it did. */
  errorLines: string[];
  qr: ReturnType<typeof buildQrPath>;
  copied: CopyTarget;
  connected: WebDeviceSummary | null;
  devices: readonly WebDeviceSummary[];
  /** Server-wide effects of the current choices (step 2). */
  impacts: readonly SharedImpact[];
  /** Whether the operator confirmed those effects. */
  acknowledged: boolean;
  onToggleAcknowledged: () => void;
  /** A one-line note carried into a step (e.g. a pairing that lapsed). */
  notice: string | null;
  onRetry: () => void;
  /** Pair from step 1 with the defaults: view only, grants as they are. */
  onPairNow: () => void;
  onNext: () => void;
  onBack: () => void;
  onRemoteChange: (remote: boolean) => void;
  onToggleUpload: () => void;
  onNameChange: (value: string) => void;
  onConnect: () => void;
  onCancel: () => void;
  onNewPairCode: () => void;
  onCopyPairUrl: () => void;
  onCopyPairCode: () => void;
  onOpenLink: (url: string) => void;
  onOpenDevices: () => void;
  onAnother: () => void;
  onExit: () => void;
  t: (key: string) => string;
}

function Lines({ lines, onOpenLink }: { lines: string[]; onOpenLink: (url: string) => void }) {
  return (
    <div className="ui-notice flex gap-2 px-3 py-2.5" data-testid="wizard-problem">
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

export function PhoneWizardView(p: PhoneWizardViewProps) {
  const { t } = p;
  const stepLabel = t('web.wizardStep')
    .replace('{step}', String(STEP_NUMBER[p.step]))
    .replace('{total}', '4');
  const header = (
    <span className="ui-note tabular-nums" data-testid="wizard-step">
      {stepLabel}
    </span>
  );
  const footer = (primary: ReactNode, back?: ReactNode) => (
    <div className="flex items-center justify-between gap-2">
      <button type="button" onClick={p.onExit} className={`${LINK} shrink-0 whitespace-nowrap`} data-testid="wizard-all-settings">
        {t('web.wizardAllSettings')}
      </button>
      <div className="flex items-center gap-2">
        {back}
        {primary}
      </div>
    </div>
  );

  if (p.step === 'check') {
    const readiness = p.diagnosis ? wizardReadiness(p.diagnosis) : null;
    const ok = readiness === 'ready' || readiness === 'shared';
    return (
      <>
        <PopoverSection title={t('web.connectPhone')} action={header}>
          <p className="text-[13px] font-medium text-[var(--text-main)]">{t('web.wizardCheckTitle')}</p>
          {readiness === null ? (
            <p className="ui-note" role="status">
              {t('web.wizardChecking')}
            </p>
          ) : ok ? (
            <p className="ui-note flex items-center gap-1.5" role="status">
              <span className="shrink-0 text-[var(--accent-green)]" aria-hidden="true">
                <IconCheck size={12} />
              </span>
              <span>{t(readiness === 'shared' ? 'web.wizardAlreadySharing' : 'web.wizardReady')}</span>
            </p>
          ) : readiness === 'needs-restart' ? (
            <p className="ui-note" role="status">
              {t('web.wizardNeedsRestart')}
            </p>
          ) : p.diagnosis && !p.diagnosis.tailscale.ok ? (
            <Lines
              lines={p.diagnosis.tailscale.lines.length > 0 ? p.diagnosis.tailscale.lines : [t('web.wizardCheckFailed')]}
              onOpenLink={p.onOpenLink}
            />
          ) : null}
          {/* Running behind a tailnet front while tailscale itself reports a
              problem: the address may reach nothing, so say it, don't bury it. */}
          {readiness === 'shared' &&
          p.diagnosis &&
          p.diagnosis.web.tailscale === true &&
          !p.diagnosis.tailscale.ok ? (
            <>
              <p className="ui-note">{t('web.wizardTailscaleWarn')}</p>
              <Lines lines={p.diagnosis.tailscale.lines} onOpenLink={p.onOpenLink} />
            </>
          ) : null}
          {p.errorLines.length > 0 ? <Lines lines={p.errorLines} onOpenLink={p.onOpenLink} /> : null}
        </PopoverSection>
        {/* Ready means one click to the QR: the defaults (view only, the
            server's grants untouched, a prefilled name) need no step 2, which
            stays one click away for anyone who wants to choose. */}
        {ok
          ? footer(
              <Button
                variant={p.busy || !p.name.trim() ? 'secondary' : 'primary'}
                size="md"
                onClick={p.onPairNow}
                disabled={p.busy || !p.name.trim()}
              >
                {p.busy ? t('web.wizardPreparing') : t('web.connectPhonePair')}
              </Button>,
              <Button variant="ghost" size="md" onClick={p.onNext} disabled={p.busy}>
                {t('web.connectPhoneOptions')}
              </Button>,
            )
          : footer(
              <Button size="md" onClick={p.onRetry} disabled={readiness === null}>
                {t('web.wizardRetry')}
              </Button>,
            )}
      </>
    );
  }

  if (p.step === 'permissions') {
    const canGo = p.name.trim().length > 0 && !p.busy && (p.impacts.length === 0 || p.acknowledged);
    return (
      <>
        <PopoverSection title={t('web.connectPhone')} action={header}>
          <p className="text-[13px] font-medium text-[var(--text-main)]">{t('web.wizardPermissionsTitle')}</p>
          <SegmentedControl<'view' | 'remote'>
            value={p.remote ? 'remote' : 'view'}
            options={[
              { value: 'view', label: t('web.wizardViewOnly'), disabled: p.busy },
              { value: 'remote', label: t('web.wizardRemoteControl'), disabled: p.busy },
            ]}
            onValueChange={(v) => p.onRemoteChange(v === 'remote')}
            ariaLabel={t('web.phoneAccess')}
            data-testid="wizard-access"
          />
          <p className="ui-note">{t(p.remote ? 'web.wizardRemoteHint' : 'web.wizardViewOnlyHint')}</p>
          <div className="ui-group">
            {/* The upload grant is server-wide, not per device: the hint says
                "paired devices" for that reason. */}
            <Field label={t('web.allowUpload')} description={t('web.allowUploadHint')} className="ui-row">
              <Checkbox checked={p.upload} disabled={p.busy} onCheckedChange={() => p.onToggleUpload()} />
            </Field>
          </div>
          <p className="ui-note">{t('web.nameHint')}</p>
          <Input
            type="text"
            value={p.name}
            onChange={(e) => p.onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canGo) p.onConnect();
            }}
            placeholder={t('web.namePlaceholder')}
            maxLength={DEVICE_NAME_MAX}
            disabled={p.busy}
            aria-label={t('web.nameHint')}
            className="w-full text-[13px]"
          />
          {p.impacts.length > 0 ? (
            <div className="ui-notice flex flex-col gap-2 px-3 py-2.5" data-testid="wizard-impacts">
              {p.impacts.map((impact) => (
                <p key={impact.key} className="ui-note flex gap-1.5">
                  <span className="mt-0.5 shrink-0 text-[var(--accent-yellow)]" aria-hidden="true">
                    <IconWarning size={11} />
                  </span>
                  <span>{t(impact.key).replace('{count}', impact.count === null ? '?' : String(impact.count))}</span>
                </p>
              ))}
              <Field label={t('web.wizardConfirmShared')}>
                <Checkbox
                  checked={p.acknowledged}
                  disabled={p.busy}
                  onCheckedChange={() => p.onToggleAcknowledged()}
                />
              </Field>
            </div>
          ) : null}
          {p.notice ? <p className="ui-note">{p.notice}</p> : null}
          {p.errorLines.length > 0 ? <Lines lines={p.errorLines} onOpenLink={p.onOpenLink} /> : null}
        </PopoverSection>
        {footer(
          <Button variant={canGo ? 'primary' : 'secondary'} size="md" onClick={p.onConnect} disabled={!canGo}>
            {p.busy ? t('web.wizardPreparing') : t('web.wizardShowQr')}
          </Button>,
          <Button variant="ghost" size="md" onClick={p.onBack} disabled={p.busy}>
            {t('web.wizardBack')}
          </Button>,
        )}
      </>
    );
  }

  if (p.step === 'qr') {
    const refusal = p.info.pairRefusal;
    return (
      <>
        <PopoverSection title={t('web.connectPhone')} action={header}>
          <p className="text-[13px] font-medium text-[var(--text-main)]">{t('web.wizardScanTitle')}</p>
          {refusal ? (
            <p className="ui-note text-[var(--text-main)]">
              {refusal.reason === 'no-front' ? t('web.refusalNoFront') : t('web.refusalInsecure')}
            </p>
          ) : p.info.pairCode && p.info.pendingDeviceName && p.info.pendingPairFlow !== 'computer' ? (
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
          <p className="ui-note flex items-center gap-1.5" role="status">
            <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--accent)]" />
            <span>{t('web.wizardWaiting')}</span>
          </p>
        </PopoverSection>
        {footer(
          <Button size="md" onClick={p.onCancel} disabled={p.busy}>
            {t('web.cancel')}
          </Button>,
        )}
      </>
    );
  }

  // done
  const live = p.devices.filter((d) => d.revokedAt === undefined);
  return (
    <>
      <PopoverSection title={t('web.connectPhone')} action={header}>
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-main)]" role="status">
          <span className="shrink-0 text-[var(--accent-green)]" aria-hidden="true">
            <IconCheck size={14} />
          </span>
          <span>{t('web.wizardConnectedTitle')}</span>
        </p>
        {p.connected ? (
          <p className="ui-note">
            {t('web.wizardConnected').replace('{name}', p.connected.name || t('web.deviceUnnamed'))}
          </p>
        ) : null}
        {live.length > 0 ? (
          <ul className="ui-group" aria-label={t('web.devicesTitle')} data-testid="wizard-devices">
            {live.map((d) => (
              <li key={d.deviceId} className="ui-row">
                <span className="shrink-0 text-[var(--text-sub)]" aria-hidden="true">
                  {d.kind === 'phone' ? (
                    <IconPhone size={14} />
                  ) : d.kind === 'computer' ? (
                    <IconComputer size={14} />
                  ) : (
                    <IconRemoteDevices size={14} />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-main)]">
                  {d.name || t('web.deviceUnnamed')}
                </span>
                {d.activeNow ? (
                  <span className="ui-note flex shrink-0 items-center gap-1">
                    <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-[var(--accent)]" />
                    {t('web.deviceActiveNow')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" onClick={p.onOpenDevices} className={`${LINK} self-start`}>
          {t('web.devicesLink')}
        </button>
      </PopoverSection>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="md" onClick={p.onAnother}>
          {t('web.wizardAnother')}
        </Button>
        <Button variant="primary" size="md" onClick={p.onExit}>
          {t('web.wizardDone')}
        </Button>
      </div>
    </>
  );
}

// ─── Stateful wizard ───────────────────────────────────────────────────────

type WebApi = NonNullable<Window['electronAPI']['web']>;

export interface PhoneConnectWizardProps {
  info: WebTerminalInfo;
  /** Hand a fresh status to the popover (its applyInfo). */
  onInfo: (info: WebTerminalInfo) => void;
  /** Leave the wizard for the full hub (stop, grants, device revoke). */
  onExit: () => void;
  onOpenDevices: () => void;
  onOpenLink: (url: string) => void;
  copied: CopyTarget;
  onCopyPairUrl: () => void;
  onCopyPairCode: () => void;
  /** The pairing in progress, owned by the popover so it survives a close. */
  session: { current: WizardSession | null };
  /** The prefilled name, unique against the roster the popover read. */
  defaultName?: string;
  t: (key: string) => string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function PhoneConnectWizard({
  info,
  onInfo,
  onExit,
  onOpenDevices,
  onOpenLink,
  copied,
  onCopyPairUrl,
  onCopyPairCode,
  session,
  defaultName = '',
  t,
}: PhoneConnectWizardProps) {
  const api = (typeof window === 'undefined' ? undefined : window.electronAPI?.web) as WebApi | undefined;
  // A pairing still in progress (the popover was closed mid-scan): go back to
  // the scan, where the watcher settles whether the phone arrived meanwhile.
  const [step, setStep] = useState<WizardStep>(() => (session.current ? 'qr' : 'check'));
  const [diagnosis, setDiagnosis] = useState<WebDiagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState(false);
  /** Seeded from the running server; always sent as an explicit boolean. */
  const [upload, setUpload] = useState(() => info.running && info.allowUpload === true);
  const [name, setName] = useState(defaultName);
  const [acknowledged, setAcknowledged] = useState(false);
  const [roster, setRoster] = useState<WebDeviceSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorLines, setErrorLines] = useState<string[]>([]);
  const [devices, setDevices] = useState<WebDeviceSummary[]>([]);
  const [connected, setConnected] = useState<WebDeviceSummary | null>(null);

  const checking = useRef(false);
  const runCheck = useCallback(async () => {
    if (!api?.diagnose || checking.current) return;
    checking.current = true;
    setDiagnosis(null);
    try {
      const d = await api.diagnose();
      setDiagnosis(d);
      onInfo(d.web);
    } catch {
      // The bridge itself failed: say "cannot tell" rather than "ready".
      setDiagnosis({ tailscale: { ok: false, problem: 'status-unreadable', lines: [] }, web: { running: false } });
    } finally {
      checking.current = false;
    }
  }, [api, onInfo]);

  useEffect(() => {
    if (step === 'check' && diagnosis === null) void runCheck();
  }, [step, diagnosis, runCheck]);

  const readRoster = useCallback(async (): Promise<WebDeviceSummary[] | null> => {
    if (!api?.deviceList) return null;
    try {
      const res = await api.deviceList();
      return res.error ? null : res.devices;
    } catch {
      return null;
    }
  }, [api]);

  // Step 2 needs the roster to say who else a server-wide change reaches.
  useEffect(() => {
    if (step !== 'permissions') return;
    let live = true;
    void readRoster().then((r) => {
      if (live) setRoster(r);
    });
    return () => {
      live = false;
    };
  }, [step, readRoster]);

  const impacts = useMemo(() => sharedImpacts(info, roster, remote, upload), [info, roster, remote, upload]);
  // A confirmation covers one attempt with the choices it was given for.
  useEffect(() => setAcknowledged(false), [remote, upload, step]);

  /** Put back what this pairing changed server-wide. Best effort. */
  const restoreGrants = useCallback(
    async (restore: WebGrantArgs) => {
      if (!api?.setGrants || Object.keys(restore).length === 0) return;
      try {
        onInfo(await api.setGrants(restore));
      } catch {
        /* the hub still shows the live values; nothing else to do here */
      }
    },
    [api, onInfo],
  );

  /** End the pairing without a phone: burn the code, then restore grants. */
  const abandon = useCallback(
    async (cancelCode: boolean) => {
      const s = session.current;
      session.current = null;
      if (cancelCode && api?.pairCancel) {
        try {
          onInfo(await api.pairCancel());
        } catch {
          /* restoring still matters more than the code */
        }
      }
      if (s) await restoreGrants(s.restore);
    },
    [api, onInfo, restoreGrants, session],
  );

  /**
   * Start if needed, widen what was chosen, mint. `quick` is step 1's Pair a
   * phone: view only and the server's upload grant as it stands, so it
   * changes nothing server-wide and has no shared impact to confirm.
   */
  const handleConnect = useCallback(async (quick = false) => {
    const trimmed = name.trim();
    if (!api || !trimmed) return;
    setBusy(true);
    setErrorLines([]);
    setNotice(null);
    const restore: WebGrantArgs = {};
    let minted = false;
    try {
      // Look again first, like the hub's Start: the popover may be a poll behind.
      let current = await api.status();
      const wantRemote = quick ? false : remote;
      const wantUpload = quick ? current.running && current.allowUpload === true : upload;
      if (!current.running) {
        // Every grant the screen shows is sent as shown, so nothing the
        // operator did not see is inherited from an earlier run.
        const args: WebStartArgs = { tailscale: true, allowInput: wantRemote, allowUpload: wantUpload };
        current = await api.start(args);
        onInfo(current);
        if (!current.running) {
          setErrorLines(current.transportError?.lines ?? (current.error ? [current.error] : []));
          return;
        }
        if (wantRemote) restore.allowInput = false;
      } else {
        // Raise input, never lower it: view-only for THIS phone must not
        // take typing away from phones already paired.
        const grants: WebGrantArgs = {};
        if (wantRemote && current.allowInput !== true) {
          grants.allowInput = true;
          restore.allowInput = false;
        }
        if (wantUpload !== (current.allowUpload === true)) {
          grants.allowUpload = wantUpload;
          restore.allowUpload = current.allowUpload === true;
        }
        if (Object.keys(grants).length > 0 && api.setGrants) {
          current = await api.setGrants(grants);
          onInfo(current);
          if (current.error) {
            setErrorLines([current.error]);
            return;
          }
        }
      }
      const mintedAt = Date.now();
      const res = await api.pairStart(trimmed, wantRemote, 'phone');
      onInfo(res);
      if (res.pairStartError || !codeIsLive(res, trimmed)) {
        setErrorLines([res.pairStartError ?? res.error ?? t('web.wizardCheckFailed')]);
        return;
      }
      session.current = { name: trimmed, remote: wantRemote, mintedAt, restore };
      minted = true;
      setStep('qr');
    } catch (err) {
      setErrorLines([errorText(err)]);
    } finally {
      if (!minted) await restoreGrants(restore);
      setBusy(false);
    }
  }, [api, name, remote, upload, onInfo, restoreGrants, session, t]);

  // While the QR is up, follow the CODE: as long as the daemon still holds it
  // under this name, keep waiting; once it is gone, the device it minted is
  // the phone — or, if none shows up, the pairing lapsed and whatever the
  // wizard widened goes back.
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
      onInfo(status);
      if (codeIsLive(status, s.name)) return;
      const list = await readRoster();
      if (stopped || session.current !== s) return;
      const device = list ? findPairedDevice(list, s.name, s.mintedAt) : null;
      if (device && list) {
        session.current = null;
        setDevices(list);
        setConnected(device);
        setStep('done');
        return;
      }
      if (list === null || ++missing.current < MISSING_DEVICE_TICKS) return;
      await abandon(false);
      if (stopped) return;
      setNotice(t('web.wizardCodeLapsed'));
      setStep('permissions');
    };
    void tick();
    const timer = setInterval(() => void tick(), PAIR_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, api, onInfo, readRoster, abandon, session, t]);

  // Same name, same CONFIRMED grant — not whatever the (disabled) picker says.
  const handleNewPairCode = useCallback(async () => {
    const s = session.current;
    if (!api || !s) return;
    setBusy(true);
    setErrorLines([]);
    try {
      const res = await api.pairStart(s.name, s.remote, 'phone');
      onInfo(res);
      if (res.pairStartError) setErrorLines([res.pairStartError]);
    } catch (err) {
      setErrorLines([errorText(err)]);
    } finally {
      setBusy(false);
    }
  }, [api, onInfo, session]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    setErrorLines([]);
    try {
      await abandon(true);
      setStep('permissions');
    } catch (err) {
      setErrorLines([errorText(err)]);
    } finally {
      setBusy(false);
    }
  }, [abandon]);

  // Leaving from the scan abandons the pairing, so a widened grant never
  // outlives the reason it was widened.
  const handleExit = useCallback(async () => {
    if (step === 'qr' && session.current) await abandon(true);
    onExit();
  }, [step, session, abandon, onExit]);

  const qrPayload = webQrPayload(info);
  const qr = useMemo(() => buildQrPath(qrPayload), [qrPayload]);

  return (
    <PhoneWizardView
      step={step}
      info={info}
      diagnosis={diagnosis}
      busy={busy}
      remote={remote}
      upload={upload}
      name={name}
      errorLines={errorLines}
      qr={qr}
      copied={copied}
      connected={connected}
      devices={devices}
      impacts={impacts}
      acknowledged={acknowledged}
      onToggleAcknowledged={() => setAcknowledged((v) => !v)}
      notice={notice}
      onRetry={() => void runCheck()}
      onPairNow={() => void handleConnect(true)}
      onNext={() => setStep('permissions')}
      onBack={() => setStep('check')}
      onRemoteChange={setRemote}
      onToggleUpload={() => setUpload((v) => !v)}
      onNameChange={(v) => setName(v.slice(0, DEVICE_NAME_MAX))}
      onConnect={() => void handleConnect()}
      onCancel={() => void handleCancel()}
      onNewPairCode={() => void handleNewPairCode()}
      onCopyPairUrl={onCopyPairUrl}
      onCopyPairCode={onCopyPairCode}
      onOpenLink={onOpenLink}
      onOpenDevices={onOpenDevices}
      onAnother={() => {
        // A fresh decision for the next phone: nothing carries over.
        setConnected(null);
        setName(uniqueDeviceName(t('web.connectPhoneDefaultName'), devices));
        setRemote(false);
        setUpload(info.running && info.allowUpload === true);
        setNotice(null);
        setErrorLines([]);
        setDiagnosis(null);
        setStep('check');
      }}
      onExit={() => void handleExit()}
      t={t}
    />
  );
}

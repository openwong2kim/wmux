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
import { DEVICE_NAME_MAX, PhonePairCode, splitLinkedLine, webQrPayload, type CopyTarget } from './WebToggle';
import {
  DEVICE_ACTIVE_WINDOW_MS,
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

/** How often the roster is re-read while the QR is on screen. */
const DEVICE_POLL_MS = 2_000;

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

/** Live (unrevoked) device ids, the baseline a new arrival is measured against. */
export function liveDeviceIds(devices: readonly WebDeviceSummary[]): Set<string> {
  return new Set(devices.filter((d) => d.revokedAt === undefined).map((d) => d.deviceId));
}

/**
 * The device that paired since `baseline` was taken, or null.
 *
 * "Recent" as well as "new": a device the daemon reports but that has not been
 * seen within the active window is not the phone in the operator's hand.
 */
export function findNewDevice(
  devices: readonly WebDeviceSummary[],
  baseline: ReadonlySet<string>,
  now: number = Date.now(),
): WebDeviceSummary | null {
  return (
    devices.find(
      (d) =>
        !baseline.has(d.deviceId) &&
        d.revokedAt === undefined &&
        (d.activeNow === true || now - d.lastSeenAt < DEVICE_ACTIVE_WINDOW_MS),
    ) ?? null
  );
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
  onRetry: () => void;
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
                <button type="button" onClick={() => onOpenLink(url)} className={LINK}>
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
      <button type="button" onClick={p.onExit} className={LINK} data-testid="wizard-all-settings">
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
        </PopoverSection>
        {footer(
          ok ? (
            <Button variant="primary" size="md" onClick={p.onNext}>
              {t('web.wizardNext')}
            </Button>
          ) : (
            <Button size="md" onClick={p.onRetry} disabled={readiness === null}>
              {t('web.wizardRetry')}
            </Button>
          ),
        )}
      </>
    );
  }

  if (p.step === 'permissions') {
    const canGo = p.name.trim().length > 0 && !p.busy;
    return (
      <>
        <PopoverSection title={t('web.connectPhone')} action={header}>
          <p className="text-[13px] font-medium text-[var(--text-main)]">{t('web.wizardPermissionsTitle')}</p>
          <SegmentedControl<'view' | 'remote'>
            value={p.remote ? 'remote' : 'view'}
            options={[
              { value: 'view', label: t('web.wizardViewOnly') },
              { value: 'remote', label: t('web.wizardRemoteControl') },
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
            aria-label={t('web.nameHint')}
            className="w-full text-[13px]"
          />
          {p.errorLines.length > 0 ? <Lines lines={p.errorLines} onOpenLink={p.onOpenLink} /> : null}
        </PopoverSection>
        {footer(
          <Button variant={p.busy ? 'secondary' : 'primary'} size="md" onClick={p.onConnect} disabled={!canGo}>
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
          ) : p.info.pairCode ? (
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
          ) : null}
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
  t: (key: string) => string;
}

export default function PhoneConnectWizard({
  info,
  onInfo,
  onExit,
  onOpenDevices,
  onOpenLink,
  copied,
  onCopyPairUrl,
  onCopyPairCode,
  t,
}: PhoneConnectWizardProps) {
  const api = (typeof window === 'undefined' ? undefined : window.electronAPI?.web) as WebApi | undefined;
  // Reopened while a phone code is live: go straight back to the scan.
  const [step, setStep] = useState<WizardStep>(() =>
    info.pairCode && info.pendingDeviceName && info.pendingPairFlow !== 'computer' ? 'qr' : 'check',
  );
  const [diagnosis, setDiagnosis] = useState<WebDiagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState(info.pendingDeviceAllowInput === true);
  /** null = untouched: the server keeps (or inherits) its own value. */
  const [upload, setUpload] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [errorLines, setErrorLines] = useState<string[]>([]);
  const [devices, setDevices] = useState<WebDeviceSummary[]>([]);
  const [connected, setConnected] = useState<WebDeviceSummary | null>(null);
  const baseline = useRef<Set<string> | null>(null);

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

  const handleConnect = useCallback(async () => {
    const trimmed = name.trim();
    if (!api || !trimmed) return;
    setBusy(true);
    setErrorLines([]);
    try {
      // Look again first, like the hub's Start: the popover may be a poll behind.
      let current = await api.status();
      if (!current.running) {
        const args: WebStartArgs = { tailscale: true, allowInput: remote, ...(upload !== null ? { allowUpload: upload } : {}) };
        current = await api.start(args);
        onInfo(current);
        if (!current.running) {
          setErrorLines(current.transportError?.lines ?? (current.error ? [current.error] : []));
          return;
        }
      } else {
        // Raise, never lower: view-only for THIS phone must not take typing
        // away from phones already paired with it.
        const grants: WebGrantArgs = {};
        if (remote && current.allowInput !== true) grants.allowInput = true;
        if (upload !== null && upload !== (current.allowUpload === true)) grants.allowUpload = upload;
        if (Object.keys(grants).length > 0 && api.setGrants) {
          current = await api.setGrants(grants);
          onInfo(current);
          if (current.error) {
            setErrorLines([current.error]);
            return;
          }
        }
      }
      const roster = await readRoster();
      baseline.current = roster ? liveDeviceIds(roster) : null;
      const minted = await api.pairStart(trimmed, remote, 'phone');
      onInfo(minted);
      if (minted.pairStartError) {
        setErrorLines([minted.pairStartError]);
        return;
      }
      setStep('qr');
    } finally {
      setBusy(false);
    }
  }, [api, name, remote, upload, onInfo, readRoster]);

  // Watch the roster while the QR is up. A device that was not in the
  // baseline and has been seen recently is the phone that just scanned.
  useEffect(() => {
    if (step !== 'qr') return;
    let stopped = false;
    const tick = async () => {
      const roster = await readRoster();
      if (stopped || !roster) return;
      // Reopened mid-scan, or the first read failed: the baseline starts here.
      if (baseline.current === null) {
        baseline.current = liveDeviceIds(roster);
        return;
      }
      const fresh = findNewDevice(roster, baseline.current);
      if (fresh) {
        setDevices(roster);
        setConnected(fresh);
        setStep('done');
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), DEVICE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, readRoster]);

  // Same code, same name, same grant — "New code" must not quietly register
  // a view-only phone after "Remote control" was chosen.
  const handleNewPairCode = useCallback(async () => {
    const pending = (info.pendingDeviceName ?? name).trim();
    if (!api || !pending) return;
    setBusy(true);
    try {
      onInfo(await api.pairStart(pending, remote, 'phone'));
    } finally {
      setBusy(false);
    }
  }, [api, info.pendingDeviceName, name, remote, onInfo]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    try {
      if (api?.pairCancel) onInfo(await api.pairCancel());
      setStep('permissions');
    } finally {
      setBusy(false);
    }
  }, [api, onInfo]);

  const qrPayload = webQrPayload(info);
  const qr = useMemo(() => buildQrPath(qrPayload), [qrPayload]);

  return (
    <PhoneWizardView
      step={step}
      info={info}
      diagnosis={diagnosis}
      busy={busy}
      remote={remote}
      upload={upload ?? (info.running && info.allowUpload === true)}
      name={name}
      errorLines={errorLines}
      qr={qr}
      copied={copied}
      connected={connected}
      devices={devices}
      onRetry={() => void runCheck()}
      onNext={() => setStep('permissions')}
      onBack={() => setStep('check')}
      onRemoteChange={setRemote}
      onToggleUpload={() => setUpload((v) => !(v ?? (info.running && info.allowUpload === true)))}
      onNameChange={(v) => setName(v.slice(0, DEVICE_NAME_MAX))}
      onConnect={() => void handleConnect()}
      onCancel={() => void handleCancel()}
      onNewPairCode={() => void handleNewPairCode()}
      onCopyPairUrl={onCopyPairUrl}
      onCopyPairCode={onCopyPairCode}
      onOpenLink={onOpenLink}
      onOpenDevices={onOpenDevices}
      onAnother={() => {
        setConnected(null);
        setName('');
        setDiagnosis(null);
        setStep('check');
      }}
      onExit={onExit}
      t={t}
    />
  );
}

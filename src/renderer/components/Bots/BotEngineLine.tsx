// ─── The Bots profile's Engine line ───────────────────────────────────────
//
// What the bot runs on: Claude (SDK), wmux's Hermes, or My Hermes (the
// owner's own Hermes profile), picked here and saved with main's engine verb
// (botsHermes.ts). Switching to either Hermes first shows whether it can run
// on this computer, then asks once; My Hermes is asked again in main's own
// native confirm. Switching back to Claude saves at once. While the bot is
// on a Hermes the line keeps that readiness under the picker. Any other
// engine (an ACP command, Claude in a terminal) shows read-only. Add bot
// uses the same picker (EngineSelect) and readiness rows.

import { useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button';
import Select from '../ui/Select';
import { FOCUS_RING } from '../focusRing';
import { useStore } from '../../stores';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { isHermesEngine, ownHermesProfile, type BotEngine } from '../../../shared/bot';
import { HERMES_INSTALL_URL, myHermesProfileLabel, type HermesReadiness, type MyHermesReadiness, type MyHermesStatus } from '../../../shared/hermesEngine';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { InlineConfirm } from './InlineConfirm';
import {
  bridgeHermesPort,
  engineOptionValue,
  hermesReadinessView,
  myHermesReadinessView,
  parseEngineOption,
  useHermesReadiness,
  useMyHermes,
  type EnginePick,
  type HermesPort,
} from './botsHermes';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The picker's choice for a stored engine, or null when it is not one the
 *  picker offers. Pure. */
export function pickableEngine(engine: BotEngine): EnginePick | null {
  if (engine.kind === 'claude-sdk') return { engine: 'claude-sdk' };
  const own = ownHermesProfile(engine);
  if (own !== null) return { engine: 'my-hermes', profile: own };
  return isHermesEngine(engine) ? { engine: 'hermes' } : null;
}

/** "My Hermes (~/.hermes)". Pure. */
export function myHermesOptionLabel(profile: string, t: T): string {
  return t('botsPage.engine.myHermes', { dir: myHermesProfileLabel(profile) });
}

function engineName(engine: BotEngine, t: T): string {
  if (engine.kind === 'claude-sdk') return t('botsPage.engine.claudeSdk');
  const own = ownHermesProfile(engine);
  if (own !== null) return myHermesOptionLabel(own, t);
  if (isHermesEngine(engine)) return t('botsPage.engine.hermes');
  if (engine.kind === 'claude-pty') return t('botsPage.engine.claudePty');
  return t('botsPage.engine.acp', { command: [engine.command, ...engine.args].join(' ') });
}

/** The engine Select: Claude, wmux's Hermes, then My Hermes per profile of
 *  the owner's (a profile another bot uses, or any on Windows, is listed
 *  but disabled). `status` null: My Hermes is not offered (an older
 *  preload) or not answered yet; `value`'s own profile is listed anyway. */
export function EngineSelect({ value, onPick, status, disabled, testId, label, botId, t }: {
  value: EnginePick;
  onPick: (pick: EnginePick) => void;
  status: MyHermesStatus | null;
  disabled?: boolean;
  testId: string;
  label: string;
  /** The bot the picker is for (its own profile is not "used by another"). */
  botId?: string;
  t: T;
}) {
  const profiles = status?.profiles ?? [];
  const listed = value.engine === 'my-hermes' && value.profile && !profiles.some((p) => p.name === value.profile)
    ? [{ name: value.profile, dir: myHermesProfileLabel(value.profile) }, ...profiles]
    : profiles;
  const unsupported = status !== null && !status.supported;
  return (
    <Select
      data-testid={testId}
      aria-label={label}
      value={engineOptionValue(value)}
      disabled={disabled}
      onChange={(e) => {
        const pick = parseEngineOption(e.target.value);
        if (pick) onPick(pick);
      }}
    >
      <option value="claude-sdk">{t('botsPage.engine.claudeSdk')}</option>
      <option value="hermes">{t('botsPage.engine.hermes')}</option>
      {unsupported && <option value="my-hermes:default" disabled>{myHermesOptionLabel('default', t)}</option>}
      {!unsupported && listed.map((p) => {
        const other = 'usedBy' in p && p.usedBy && p.usedBy.botId !== botId ? p.usedBy : null;
        return (
          <option key={p.name} value={engineOptionValue({ engine: 'my-hermes', profile: p.name })} disabled={other !== null}>
            {other ? t('botsPage.engine.myHermesUsedBy', { label: myHermesOptionLabel(p.name, t), bot: other.name }) : myHermesOptionLabel(p.name, t)}
          </option>
        );
      })}
    </Select>
  );
}

/** The one muted line under the picker on Windows. */
export function MyHermesUnsupportedLine({ status, t }: { status: MyHermesStatus | null; t: T }) {
  if (!status || status.supported) return null;
  return <p data-bots-my-hermes-unsupported className="mt-1 text-[11px] text-[var(--text-muted)]">{t('botsPage.myHermes.unsupportedOs')}</p>;
}

/** Whether My Hermes can serve a bot, in the line's words: one line, a
 *  command to copy when one fixes it, the notices (muted; colour carries
 *  no state here), and Check again. */
export function MyHermesReadinessRow({ readiness, checking, recheck, t, profile }: {
  readiness: MyHermesReadiness | null;
  /** The profile it is about (its fix commands name it). */
  profile: string;
  checking: boolean;
  recheck: () => void;
  t: T;
}) {
  const [copied, setCopied] = useState(false);
  if (!readiness) {
    return <p data-bots-my-hermes-readiness="checking" className="mt-1 text-[11px] text-[var(--text-muted)]">{t('botsPage.hermes.checking')}</p>;
  }
  const view = myHermesReadinessView(readiness, profile);
  const copy = () => {
    if (!view.command) return;
    void navigator.clipboard?.writeText(view.command).then(() => setCopied(true), () => undefined);
  };
  return (
    <div data-bots-my-hermes-readiness={readiness.ready ? 'ready' : readiness.reason} role="status" className="mt-1 flex flex-col gap-1 text-[11px] leading-snug">
      <p className={readiness.ready ? 'text-[var(--text-muted)]' : 'text-[var(--text-sub)]'}>{t(view.key, view.vars)}</p>
      {view.command && (
        <div className="flex min-w-0 items-center gap-2">
          <code data-bots-my-hermes-command className="min-w-0 truncate rounded-[6px] bg-[var(--selection-subtle)] px-1.5 py-0.5 font-mono text-[var(--text-sub)]">{view.command}</code>
          <button
            type="button"
            data-bots-my-hermes-copy
            onClick={copy}
            onBlur={() => setCopied(false)}
            className={`shrink-0 text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          >
            {copied ? t('botsPage.chat.copied') : t('botsPage.chat.copyCode')}
          </button>
        </div>
      )}
      {readiness.notices.map((n) => (
        <p key={n.kind} data-bots-my-hermes-notice={n.kind} className="text-[var(--text-muted)]">
          {n.kind === 'approvals-smart'
            ? t('botsPage.myHermes.noticeSmart')
            : n.kind === 'allowlist'
              ? t('botsPage.myHermes.noticeAllowlist', { count: n.count })
              : t('botsPage.myHermes.noticeMcp', { names: n.names.join(', ') })}
        </p>
      ))}
      {readiness.reason !== 'unsupported-os' && (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" data-bots-my-hermes-recheck disabled={checking} onClick={recheck}>{t('botsPage.onboarding.checkAgain')}</Button>
        </div>
      )}
    </div>
  );
}

function openHermesPage(): void {
  void window.electronAPI?.shell?.openExternal?.(HERMES_INSTALL_URL)?.catch?.(() => undefined);
}

/** Whether Hermes can run here, in the line's words, with its one fix. */
export function HermesReadinessRow({ readiness, checking, recheck, port, t }: {
  readiness: HermesReadiness | null;
  checking: boolean;
  recheck: () => void;
  port: HermesPort;
  t: T;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!readiness) {
    return <p data-bots-hermes-readiness="checking" className="mt-1 text-[11px] text-[var(--text-muted)]">{t('botsPage.hermes.checking')}</p>;
  }
  const view = hermesReadinessView(readiness);
  // Without the setup verb the owner can still ask again after setting up.
  const fix = view.fix === 'setup' && !port.setup ? 'recheck' : view.fix;
  const setUp = async () => {
    if (!port.setup) return;
    setBusy(true);
    try {
      await port.setup();
      // The setup runs in a terminal tab the page steps aside to (as the
      // Claude sign-in does).
      const st = useStore.getState();
      st.pushToast({ message: t('botsPage.hermes.setupOpened'), level: 'info' });
      showWorkspaces(st);
    } catch (err) {
      useStore.getState().pushToast({ message: err instanceof Error ? err.message : String(err), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!view.command) return;
    void navigator.clipboard?.writeText(view.command).then(() => setCopied(true), () => undefined);
  };
  return (
    <div data-bots-hermes-readiness={readiness.ready ? 'ready' : readiness.reason} role="status" className="mt-1 flex flex-col gap-1 text-[11px] leading-snug">
      <p className={readiness.ready ? 'text-[var(--text-muted)]' : 'text-[var(--text-sub)]'}>{t(view.key, view.vars)}</p>
      {readiness.ready && <p data-bots-hermes-can-do className="text-[var(--text-muted)]">{t('botsPage.hermes.canDo')}</p>}
      {view.command && (
        <div className="flex min-w-0 items-center gap-2">
          <code data-bots-hermes-command className="min-w-0 truncate rounded-[6px] bg-[var(--selection-subtle)] px-1.5 py-0.5 font-mono text-[var(--text-sub)]">{view.command}</code>
          <button
            type="button"
            data-bots-hermes-copy
            onClick={copy}
            onBlur={() => setCopied(false)}
            className={`shrink-0 text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          >
            {copied ? t('botsPage.chat.copied') : t('botsPage.chat.copyCode')}
          </button>
        </div>
      )}
      {fix && (
        <div className="flex items-center gap-1.5">
          {fix === 'install' && <Button size="sm" variant="secondary" data-bots-hermes-install onClick={openHermesPage}>{t('botsPage.hermes.install')}</Button>}
          {fix === 'setup' && <Button size="sm" variant="secondary" data-bots-hermes-setup disabled={busy} onClick={() => void setUp()}>{t('botsPage.hermes.setup')}</Button>}
          {fix === 'recheck' && <Button size="sm" variant="ghost" data-bots-hermes-recheck disabled={checking} onClick={recheck}>{t('botsPage.onboarding.checkAgain')}</Button>}
        </div>
      )}
      {view.detail && (
        <>
          <button
            type="button"
            data-bots-hermes-details
            className="self-start text-[var(--text-muted)] underline-offset-2 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t('botsPage.engineError.hideDetails') : t('botsPage.engineError.showDetails')}
          </button>
          {open && (
            <pre data-bots-hermes-detail className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--selection-subtle)] px-2 py-1 text-[var(--text-muted)]">
              {view.detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** The bot's engine. `port`: the Hermes verbs (default: the preload's). */
export function BotEngineLine({ row, t, port: given }: { row: FactoryBotRow; t: T; port?: HermesPort }) {
  const port = useMemo(() => given ?? bridgeHermesPort(), [given]);
  const current = pickableEngine(row.bot.engine);
  const currentValue = current ? engineOptionValue(current) : null;
  const [staged, setStaged] = useState<EnginePick | null>(null);
  const [pending, setPending] = useState<EnginePick | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A save in flight shows its value until the profile catches up.
  useEffect(() => { if (pending !== null && engineOptionValue(pending) === currentValue) setPending(null); }, [pending, currentValue]);
  useEffect(() => { if (staged !== null && engineOptionValue(staged) === currentValue) setStaged(null); }, [staged, currentValue]);
  const shown = staged ?? pending ?? current;
  const onHermes = shown?.engine === 'hermes';
  const ownProfile = shown?.engine === 'my-hermes' ? shown.profile ?? 'default' : null;
  const { readiness, checking, recheck } = useHermesReadiness(port.readiness, onHermes);
  const editable = current !== null && !!port.setEngine;
  const my = useMyHermes(port.myHermes, editable, ownProfile);
  const label = t('botsPage.engine.label');
  const setEngine = port.setEngine;

  const save = async (value: EnginePick) => {
    if (!setEngine) return;
    setStaged(null);
    setPending(value);
    setError(null);
    try {
      const r = value.engine === 'my-hermes' ? await setEngine(row.bot.id, 'my-hermes', value.profile) : await setEngine(row.bot.id, value.engine);
      if (!r.ok) {
        setPending(null);
        // Declined in main's confirm: nothing changed, nothing to say.
        if (r.code !== 'cancelled') setError(r.message || t('botsPage.engine.saveFailed'));
      }
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const pick = (value: EnginePick) => {
    setError(null);
    if (engineOptionValue(value) === currentValue) setStaged(null);
    else if (value.engine === 'claude-sdk') void save(value);
    else setStaged(value);
  };

  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-engine>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1">
        {!editable || shown === null ? (
          <span data-testid="bots-profile-engine-value" className="text-[var(--text-main)]">{engineName(row.bot.engine, t)}</span>
        ) : (
          <EngineSelect
            testId="bots-profile-engine"
            label={label}
            value={shown}
            onPick={pick}
            status={my.status}
            disabled={pending !== null}
            botId={row.bot.id}
            t={t}
          />
        )}
        {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
        {editable && <MyHermesUnsupportedLine status={my.status} t={t} />}
        {onHermes && port.readiness && <HermesReadinessRow readiness={readiness} checking={checking} recheck={recheck} port={port} t={t} />}
        {ownProfile !== null && port.myHermes && <MyHermesReadinessRow readiness={my.readiness} checking={my.checking} recheck={my.recheck} profile={ownProfile} t={t} />}
        {staged && (
          <div className="mt-1.5">
            <InlineConfirm
              text={staged.engine === 'my-hermes'
                ? t('botsPage.engine.myHermesSwitchConfirm', { name: row.bot.name })
                : t('botsPage.engine.switchConfirm', { name: row.bot.name })}
              confirmLabel={staged.engine === 'my-hermes' ? t('botsPage.engine.useMyHermes') : t('botsPage.engine.switch')}
              cancelLabel={t('settings.factory.cancel')}
              busy={false}
              tone="primary"
              testId="bots-profile-engine-switch"
              onConfirm={() => void save(staged)}
              onCancel={() => setStaged(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Add bot's Engine row: the profile's picker for a bot not made yet, with
 *  the picked Hermes's readiness under it. Claude stays the default; My
 *  Hermes is asked in main's own confirm when Add is pressed. */
export function AddBotEngineRow({ value, onPick, t, port: given, disabled }: {
  value: EnginePick;
  onPick: (pick: EnginePick) => void;
  t: T;
  port?: HermesPort;
  disabled?: boolean;
}) {
  const port = useMemo(() => given ?? bridgeHermesPort(), [given]);
  const ownProfile = value.engine === 'my-hermes' ? value.profile ?? 'default' : null;
  const managed = useHermesReadiness(port.readiness, value.engine === 'hermes');
  const my = useMyHermes(port.myHermes, true, ownProfile);
  const label = t('botsPage.engine.label');
  return (
    <div data-testid="factory-add-bot-engine-row" className="flex items-start gap-2 text-[12px] text-[var(--text-sub)]">
      <span className="w-[120px] shrink-0 pt-[3px]">{label}</span>
      <div className="min-w-0 flex-1">
        <EngineSelect testId="factory-add-bot-engine" label={label} value={value} onPick={onPick} status={my.status} disabled={disabled} t={t} />
        <MyHermesUnsupportedLine status={my.status} t={t} />
        {value.engine === 'hermes' && port.readiness && <HermesReadinessRow readiness={managed.readiness} checking={managed.checking} recheck={managed.recheck} port={port} t={t} />}
        {ownProfile !== null && port.myHermes && <MyHermesReadinessRow readiness={my.readiness} checking={my.checking} recheck={my.recheck} profile={ownProfile} t={t} />}
      </div>
    </div>
  );
}

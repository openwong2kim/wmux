// ─── Moa tab — the HQ main bot: switch, engine, HQ, modes, limits ────────────
//
// Replaces the Orchestrator tab and keeps every row it had (engine, model,
// effort, full power, auto-wake, ledger gate, channels tab, briefing). Main
// owns all Moa state (deckHqStore); this tab reads it from the store's Moa
// slice and writes through the deck bridge, re-reading after every write.
//
// Every row renders before the first read answers (controls inert, status
// "Checking…"), so search can always jump to it.

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../../stores';
import { isMoaHqWorkspace } from '../../stores/slices/moaSlice';
import { useT } from '../../hooks/useT';
import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_OPTIONS } from '../../../shared/claudeModels';
import { MOA_MAX_TURNS_PER_HOUR_RANGE, type MoaConfigPatch, type MoaMemoryItem } from '../../../shared/moa';
import type { RetroSchedule } from '../../../shared/trackRecord';
import type { AgentMode } from '../../../main/deck/deckAutonomyStore';
import { notifyBriefingConfigChanged } from '../Deck/deckBriefingConfigBus';
import { notifyAgentModeChanged, onAgentModeChanged } from '../Deck/deckModeBus';
import MoaFirstRunCard from '../Moa/MoaFirstRunCard';
import MoaArchiveDialog from '../Moa/MoaArchiveDialog';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Select from '../ui/Select';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import Badge from '../ui/Badge';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';

const MODES: readonly AgentMode[] = ['off', 'assist', 'danger'];
const isMode = (v: unknown): v is AgentMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

function MoaSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="settings-select">
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </Select>
  );
}

/** Validate the hourly turn cap the operator typed. */
export function parseTurnCap(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= MOA_MAX_TURNS_PER_HOUR_RANGE.min && n <= MOA_MAX_TURNS_PER_HOUR_RANGE.max ? n : null;
}

export interface TabMoaProps {
  /** Settings' owned-dialog counter: while a dialog this tab opened is up,
   *  Escape belongs to it, not to the Settings page underneath. */
  registerDialog?: (delta: number) => void;
}

export function TabMoa({ registerDialog }: TabMoaProps) {
  const t = useT();
  const moa = useStore((s) => s.moa);
  const refreshMoa = useStore((s) => s.refreshMoa);
  const createMoaHq = useStore((s) => s.createMoaHq);
  const openMoaHq = useStore((s) => s.openMoaHq);
  const hqPending = useStore((s) => s.moaHqPendingId !== null);
  const setSettingsPanelVisible = useStore((s) => s.setSettingsPanelVisible);
  const workspaces = useStore((s) => s.workspaces);

  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const setDeckBrainModel = useStore((s) => s.setDeckBrainModel);
  const deckBrainEffort = useStore((s) => s.deckBrainEffort);
  const setDeckBrainEffort = useStore((s) => s.setDeckBrainEffort);
  const deckBrainFullPower = useStore((s) => s.deckBrainFullPower);
  const setDeckBrainFullPower = useStore((s) => s.setDeckBrainFullPower);
  const deckBrainVendor = useStore((s) => s.deckBrainVendor);
  const setDeckBrainVendor = useStore((s) => s.setDeckBrainVendor);
  const channelsTabVisible = useStore((s) => s.channelsTabVisible);
  const setChannelsTabVisible = useStore((s) => s.setChannelsTabVisible);

  const loaded = moa != null;
  const enabled = moa?.config.enabled ?? false;
  const hqState = moa?.hq.state ?? 'hq-unknown';
  const unacked = moa?.archive.unacked ?? 0;

  // ── Moa state: read on open (the app-wide sync hook keeps it fresh) ──
  useEffect(() => { void refreshMoa(); }, [refreshMoa]);

  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const dialogOpen = firstRunOpen || archiveOpen;
  useEffect(() => {
    if (!dialogOpen || !registerDialog) return;
    registerDialog(1);
    return () => registerDialog(-1);
  }, [dialogOpen, registerDialog]);

  // ── What Moa remembers: re-read whenever main says Moa moved ──
  const [memory, setMemory] = useState<MoaMemoryItem[] | null>(null);
  const [memoryFailed, setMemoryFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const api = window.electronAPI.deck?.moa;
    if (!api?.memoryList) return;
    api.memoryList().then(
      (r) => { if (live) setMemory(r?.items ?? []); },
      () => { if (live) setMemory([]); },
    );
    return () => { live = false; };
  }, [moa]);
  const onForget = async (item: MoaMemoryItem) => {
    setMemoryFailed(false);
    try {
      const r = await window.electronAPI.deck?.moa?.memoryDelete(item.kind, item.name);
      if (!r?.ok) setMemoryFailed(true);
    } catch {
      setMemoryFailed(true);
    }
    await refreshMoa();
  };

  // ── Master switch ──
  const [switchFailed, setSwitchFailed] = useState(false);
  const onSwitchChange = async (next: boolean) => {
    if (!moa) return;
    // An existing orchestrator user (the switch defaulted on for them) with no
    // HQ is re-enabling the behaviour they already had: no card. The card is
    // reachable from the HQ row's "Set up Moa".
    const existingNoHq = moa.config.defaultReason === 'existing-brain' && moa.hq.state === 'unset';
    // Turning on before the first-run card was ever seen (or with no HQ at
    // all) goes through the card: that is where the HQ gets made.
    if (next && !existingNoHq && (!moa.config.onboarded || moa.hq.state === 'unset')) {
      setFirstRunOpen(true);
      return;
    }
    setSwitchFailed(false);
    try {
      const r = await window.electronAPI.deck?.moa?.set(next);
      if (!r?.ok) setSwitchFailed(true);
    } catch {
      setSwitchFailed(true);
    }
    await refreshMoa();
  };

  // ── HQ status and its one-click recovery ──
  const [hqBusy, setHqBusy] = useState(false);
  const [hqFailed, setHqFailed] = useState(false);
  const runHqAction = async (action: () => Promise<boolean>) => {
    setHqBusy(true);
    setHqFailed(false);
    let ok = false;
    try {
      ok = await action();
    } catch {
      ok = false;
    }
    setHqBusy(false);
    if (!ok) setHqFailed(true);
  };
  const recreateHq = () => runHqAction(async () => (await createMoaHq()).ok);
  const resetStore = () => runHqAction(async () => {
    const r = await window.electronAPI.deck?.moa?.resetStore();
    await refreshMoa();
    return !!r?.ok;
  });
  const openHq = () => {
    openMoaHq();
    setSettingsPanelVisible(false);
  };

  let hqBadge: { tone: 'neutral' | 'success' | 'warning' | 'danger'; text: string };
  let hqDesc: string;
  let hqAction: ReactNode = null;
  // A setup main committed but did not finish wins over the reported state:
  // main may already say "ok" for a workspace whose mode, caps or switch
  // never got set. The retry runs setup again on the same workspace.
  switch (hqPending ? 'pending' : hqState) {
    case 'pending':
      hqBadge = { tone: 'warning', text: t('moa.settings.hqPending') };
      hqDesc = t('moa.settings.hqPendingDesc');
      hqAction = (
        <Button variant="primary" size="md" onClick={() => { void recreateHq(); }} disabled={hqBusy} data-testid="moa-hq-finish">
          {t('moa.firstRun.finish')}
        </Button>
      );
      break;
    case 'ok':
      hqBadge = { tone: 'success', text: t('moa.settings.hqReady') };
      hqDesc = enabled ? t('moa.settings.hqReadyDesc') : t('moa.settings.hqOffDesc');
      hqAction = (
        <Button variant="secondary" size="md" onClick={openHq} data-testid="moa-hq-open">
          {t('moa.settings.hqOpen')}
        </Button>
      );
      break;
    case 'hq-missing':
      hqBadge = { tone: 'warning', text: t('moa.settings.hqMissing') };
      hqDesc = t('moa.settings.hqMissingDesc');
      hqAction = (
        <Button variant="primary" size="md" onClick={() => { void recreateHq(); }} disabled={hqBusy} data-testid="moa-hq-recreate">
          {t('moa.settings.hqRecreate')}
        </Button>
      );
      break;
    case 'hq-store-corrupt':
      hqBadge = { tone: 'danger', text: t('moa.settings.hqCorrupt') };
      hqDesc = t('moa.settings.hqCorruptDesc');
      hqAction = (
        <Button variant="destructive" size="md" onClick={() => { void resetStore(); }} disabled={hqBusy} data-testid="moa-hq-reset">
          {t('moa.settings.hqReset')}
        </Button>
      );
      break;
    case 'unset':
      hqBadge = { tone: 'neutral', text: t('moa.settings.hqUnset') };
      hqDesc = t('moa.settings.hqUnsetDesc');
      hqAction = (
        <Button variant="primary" size="md" onClick={() => setFirstRunOpen(true)} data-testid="moa-hq-setup">
          {t('moa.settings.hqSetup')}
        </Button>
      );
      break;
    default:
      hqBadge = { tone: 'neutral', text: t('moa.settings.hqChecking') };
      hqDesc = t('moa.settings.hqCheckingDesc');
  }

  // ── Moa settings (the hourly turn cap) ──
  const [saveFailed, setSaveFailed] = useState(false);
  const patchConfig = async (patch: MoaConfigPatch) => {
    setSaveFailed(false);
    try {
      const r = await window.electronAPI.deck?.moa?.setConfig(patch);
      if (!r?.ok) setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    }
    await refreshMoa();
  };

  const storedCap = moa?.config.maxTurnsPerHour;
  const [capDraft, setCapDraft] = useState('');
  const [capInvalid, setCapInvalid] = useState(false);
  useEffect(() => {
    if (storedCap != null) setCapDraft(String(storedCap));
    setCapInvalid(false);
  }, [storedCap]);
  const commitCap = () => {
    if (!loaded) return;
    const n = parseTurnCap(capDraft);
    if (n === null) {
      setCapInvalid(true);
      return;
    }
    setCapInvalid(false);
    if (n !== storedCap) void patchConfig({ maxTurnsPerHour: n });
  };

  // ── Per-workspace modes (every workspace but the HQ) ──
  const modeRows = workspaces.filter((w) => !isMoaHqWorkspace({ moa }, w.id));
  const modeIds = modeRows.map((w) => w.id).join('\n');
  const [modes, setModes] = useState<Record<string, AgentMode>>({});
  const [modeFailed, setModeFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      for (const id of modeIds ? modeIds.split('\n') : []) {
        window.electronAPI.deck?.mode
          ?.get(id)
          .then((r) => {
            const m = r?.mode;
            if (!cancelled && isMode(m)) setModes((prev) => ({ ...prev, [id]: m }));
          })
          .catch(() => undefined);
      }
    };
    read();
    const off = onAgentModeChanged(read);
    return () => { cancelled = true; off(); };
  }, [modeIds]);
  const onModeChange = (id: string, next: AgentMode) => {
    const prev = modes[id];
    setModeFailed(false);
    setModes((m) => ({ ...m, [id]: next }));
    const revert = () => {
      setModeFailed(true);
      setModes((m) => {
        const copy = { ...m };
        if (prev) copy[id] = prev;
        else delete copy[id];
        return copy;
      });
    };
    window.electronAPI.deck?.mode
      ?.set(id, next)
      .then((r) => {
        if (r?.ok && isMode(r.mode)) setModes((m) => ({ ...m, [id]: r.mode as AgentMode }));
        else if (!r?.ok) revert();
        notifyAgentModeChanged();
      })
      .catch(revert);
  };
  const modeOptions = MODES.map((m) => ({ value: m, label: t(`deck.mode.${m}`) }));

  // ── Existing orchestrator rows (moved from the Orchestrator tab) ──
  // Global auto-wake switch — persisted in MAIN (deck-autowake.json) because
  // the event-push coalescer that spends the tokens lives there. Read on
  // mount; optimistic toggle with echo reconciliation.
  const [autoWake, setAutoWake] = useState(true);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.autoWake
      ?.get()
      .then((r) => { if (!cancelled) setAutoWake(r.enabled); })
      .catch(() => undefined); // keep the default-on rendering
    return () => { cancelled = true; };
  }, []);
  const onAutoWakeChange = (next: boolean) => {
    setAutoWake(next);
    window.electronAPI.deck?.autoWake
      ?.set(next)
      .then((r) => setAutoWake(r.enabled))
      .catch(() => setAutoWake(!next));
  };
  // `deck.ledgerGate` — persisted in MAIN (deck-ledger-gate.json), the same
  // file the Stop gate reads, so the toggle and the gate can never disagree and
  // the choice survives a restart. Default OFF; same optimistic-toggle-with-
  // echo shape as auto-wake, except the default rendering is off, so a failed
  // read leaves the switch showing the behaviour actually in force.
  const [ledgerGate, setLedgerGate] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.ledgerGate
      ?.get()
      .then((r) => { if (!cancelled) setLedgerGate(r.enabled); })
      .catch(() => undefined); // keep the default-off rendering
    return () => { cancelled = true; };
  }, []);
  const onLedgerGateChange = (next: boolean) => {
    setLedgerGate(next);
    window.electronAPI.deck?.ledgerGate
      ?.set(next)
      .then((r) => setLedgerGate(r.enabled))
      .catch(() => setLedgerGate(!next));
  };
  // D1 briefing toggles — persisted in MAIN (deck-briefing.json). Read on mount;
  // optimistic toggle with echo reconciliation (mirrors auto-wake).
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [briefingAutoShow, setBriefingAutoShow] = useState(true);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.briefing
      ?.getConfig()
      .then((c) => {
        if (cancelled) return;
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
      })
      .catch(() => undefined); // keep the default-on rendering
    return () => { cancelled = true; };
  }, []);
  // A mounted DeckBriefingCard reads its config from main, not from this
  // component's state, so every confirmed change is broadcast — otherwise a card
  // that is already on screen stays visible after the operator turns it off.
  const onBriefingEnabledChange = (next: boolean) => {
    setBriefingEnabled(next);
    window.electronAPI.deck?.briefing
      ?.setConfig({ enabled: next })
      .then((c) => {
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
        notifyBriefingConfigChanged();
      })
      .catch(() => setBriefingEnabled(!next));
  };
  const onBriefingAutoShowChange = (autoShow: boolean) => {
    setBriefingAutoShow(autoShow);
    window.electronAPI.deck?.briefing
      ?.setConfig({ autoShow })
      .then((c) => {
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
        notifyBriefingConfigChanged();
      })
      .catch(() => setBriefingAutoShow(!autoShow));
  };
  // Weekly retro + track record — persisted in MAIN (track-record.json). Read
  // on mount; each change returns the stored schedule.
  const [retro, setRetro] = useState<RetroSchedule | null>(null);
  const [statsCleared, setStatsCleared] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.trackRecord
      ?.getSchedule()
      .then((r) => { if (!cancelled) setRetro(r); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const patchRetro = (patch: Partial<RetroSchedule>) => {
    setSaveFailed(false);
    window.electronAPI.trackRecord
      ?.setSchedule(patch)
      .then(setRetro)
      .catch(() => setSaveFailed(true));
  };
  const clearStats = () => {
    setStatsCleared(false);
    window.electronAPI.trackRecord
      ?.clear()
      .then((r) => setStatsCleared(r.ok))
      .catch(() => setSaveFailed(true));
  };
  const dayOptions = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
    // 2024-01-07 was a Sunday: the locale names the weekday.
    value: String(d),
    label: new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'long' }),
  }));
  const hourOptions = Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }));
  const options = CLAUDE_MODEL_OPTIONS.map((o) => ({
    value: o.value,
    label: o.value === '' ? t('settings.orchestratorModelDefault') : o.label,
  }));
  // A hand-typed / newer id that is not in the list still shows as itself.
  if (deckBrainModel && !options.some((o) => o.value === deckBrainModel)) {
    options.push({ value: deckBrainModel, label: deckBrainModel });
  }
  const effortOptions = [
    { value: '', label: t('settings.orchestratorEffortDefault') },
    ...CLAUDE_EFFORT_LEVELS.map((l) => ({ value: l, label: l })),
  ];

  return (
    <div className="settings-page" data-testid="moa-tab">
      {unacked > 0 && (
        <SettingsSection data-testid="moa-archive-notice">
          <SettingRow
            label={unacked === 1 ? t('moa.archive.noticeOne') : t('moa.archive.notice', { count: unacked })}
            description={t('moa.archive.noticeDesc')}
          >
            <Button variant="secondary" size="md" onClick={() => setArchiveOpen(true)} data-testid="moa-archive-view">
              {t('moa.archive.view')}
            </Button>
          </SettingRow>
        </SettingsSection>
      )}

      <SettingsSection data-testid="moa-section">
        <SettingRow id="moaswitch" label={t('moa.settings.switch')} description={t('moa.settings.switchDesc')}>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => { void onSwitchChange(v); }}
            aria-label={t('moa.settings.switch')}
            disabled={!loaded}
          />
        </SettingRow>
        {switchFailed && (
          <SettingNote tone="danger" role="alert" data-testid="moa-switch-error">
            {t('moa.settings.switchFailed')}
          </SettingNote>
        )}
        <SettingRow id="brain" label={t('moa.settings.engine')} description={t('moa.settings.engineDesc')}>
          <MoaSelect
            value={deckBrainVendor}
            onChange={(v) => setDeckBrainVendor(v === 'claude' || v === 'hermes' ? v : 'claude-pty')}
            options={[
              { value: 'claude-pty', label: t('moa.settings.engineClaudePty') },
              { value: 'claude', label: t('moa.settings.engineClaudeSdk') },
              { value: 'hermes', label: t('moa.settings.engineAcp') },
            ]}
            label={t('moa.settings.engine')}
          />
        </SettingRow>
        {/* Picking the terminal runtime does not only swap the agent behind the
            orchestrator: the panel itself becomes an embedded Claude Code TUI
            instead of the chat surface. That is the change people actually
            notice, and nothing said so before they picked it. */}
        {deckBrainVendor === 'claude-pty' && (
          <SettingNote data-testid="orchestrator-claude-pty-note">
            {t('settings.orchestratorBrainClaudePtyNote')}
          </SettingNote>
        )}
        <SettingRow id="model" label={t('settings.orchestratorModel')} description={t('settings.orchestratorModelDesc')}>
          <MoaSelect
            value={deckBrainModel}
            onChange={setDeckBrainModel}
            options={options}
            label={t('settings.orchestratorModel')}
          />
        </SettingRow>
        {/* Effort reaches both Claude runtimes (SDK options.effort / TUI
            --effort); an ACP brain ignores it, so the row hides there. */}
        {deckBrainVendor !== 'hermes' && (
          <SettingRow id="effort" label={t('settings.orchestratorEffort')} description={t('settings.orchestratorEffortDesc')}>
            <MoaSelect
              value={deckBrainEffort}
              onChange={setDeckBrainEffort}
              options={effortOptions}
              label={t('settings.orchestratorEffort')}
            />
          </SettingRow>
        )}
        <SettingRow id="moahq" label={t('moa.settings.hq')} description={hqDesc}>
          <div className="flex items-center gap-3" data-testid="moa-hq-status" data-hq-state={hqState}>
            <Badge tone={hqBadge.tone}>{hqBadge.text}</Badge>
            {hqAction}
          </div>
        </SettingRow>
        {hqFailed && (
          <SettingNote tone="danger" role="alert" data-testid="moa-hq-error">
            {t('moa.settings.hqActionFailed')}
          </SettingNote>
        )}
      </SettingsSection>

      <SettingsSection
        id="moamodes"
        title={t('moa.settings.modes')}
        description={loaded && !enabled ? t('moa.settings.modesOff') : t('moa.settings.modesDesc')}
        data-testid="moa-modes"
      >
        {modeRows.length === 0 && <SettingNote>{t('moa.settings.modesEmpty')}</SettingNote>}
        {modeRows.map((w) => (
          <SettingRow key={w.id} label={w.name}>
            {modes[w.id] ? (
              <SegmentedControl
                value={modes[w.id]}
                options={modeOptions}
                onValueChange={(m) => onModeChange(w.id, m)}
                data-testid={`moa-mode-${w.id}`}
              />
            ) : (
              <span className="ui-note">{t('moa.settings.modeLoading')}</span>
            )}
          </SettingRow>
        ))}
        {modeFailed && (
          <SettingNote tone="danger" role="alert">{t('moa.settings.saveFailed')}</SettingNote>
        )}
      </SettingsSection>

      <SettingsSection>
        <SettingRow id="moaturncap" label={t('moa.settings.turnCap')} description={t('moa.settings.turnCapDesc')}>
          <Input
            type="number"
            inputMode="numeric"
            min={MOA_MAX_TURNS_PER_HOUR_RANGE.min}
            max={MOA_MAX_TURNS_PER_HOUR_RANGE.max}
            step={1}
            value={capDraft}
            disabled={!loaded}
            aria-invalid={capInvalid || undefined}
            onChange={(e) => setCapDraft(e.target.value)}
            onBlur={commitCap}
            onKeyDown={(e) => { if (e.key === 'Enter') commitCap(); }}
            className="settings-input tabular-nums text-center"
            style={{ width: 96 }}
            data-testid="moa-turn-cap"
          />
        </SettingRow>
        {capInvalid && (
          <SettingNote tone="danger" role="alert" data-testid="moa-turn-cap-error">
            {t('moa.settings.turnCapInvalid', MOA_MAX_TURNS_PER_HOUR_RANGE)}
          </SettingNote>
        )}
        {saveFailed && (
          <SettingNote tone="danger" role="alert" data-testid="moa-save-error">
            {t('moa.settings.saveFailed')}
          </SettingNote>
        )}
        <SettingRow
          id="moaapprovalpress"
          label={t('moa.settings.approvalPress')}
          description={t('moa.settings.approvalPressDesc')}
        >
          <Switch
            checked={moa?.config.approvalPress === true}
            onCheckedChange={(v) => { void patchConfig({ approvalPress: v }); }}
            aria-label={t('moa.settings.approvalPress')}
            disabled={!loaded}
            data-testid="moa-approval-press"
          />
        </SettingRow>
        {/* Full power tunes settingSources/canUseTool — both SDK-only knobs. The
            terminal brain (an interactive TUI) and ACP brains ignore the flag
            entirely (see createAdapter in deck.handler), so with the terminal
            brain now the default the row would otherwise read as a toggle that
            does nothing when clicked. Inert + a reason instead of hidden: the
            setting still exists, it just belongs to the other vendor. */}
        <SettingRow
          id="fullpower"
          label={t('settings.orchestratorFullPower')}
          description={
            deckBrainVendor === 'claude'
              ? t('settings.orchestratorFullPowerDesc')
              : t('settings.orchestratorFullPowerSdkOnly')
          }
        >
          <Switch
            checked={deckBrainFullPower}
            onCheckedChange={setDeckBrainFullPower}
            aria-label={t('settings.orchestratorFullPower')}
            disabled={deckBrainVendor !== 'claude'}
          />
        </SettingRow>
        <SettingRow id="autowake" label={t('settings.autoWake')} description={t('settings.autoWakeDesc')}>
          <Switch checked={autoWake} onCheckedChange={onAutoWakeChange} aria-label={t('settings.autoWake')} />
        </SettingRow>
        {/* Experimental on purpose: this replaces the shipped Stop gate's
            snapshot inference with the task ledger, and the ledger has not run a
            full dogfood yet (orchestrator track, 2026-09). */}
        <SettingRow id="ledgergate" label={t('settings.ledgerGate')} description={t('settings.ledgerGateDesc')}>
          <div className="flex items-center gap-3">
            <Badge title={t('settings.ledgerGateDesc')}>{t('settings.mcpExperimental')}</Badge>
            <Switch checked={ledgerGate} onCheckedChange={onLedgerGateChange} aria-label={t('settings.ledgerGate')} />
          </div>
        </SettingRow>
        <SettingRow label={t('settings.channelsTabVisible')} description={t('settings.channelsTabVisibleDesc')}>
          <Switch
            checked={channelsTabVisible}
            onCheckedChange={setChannelsTabVisible}
            aria-label={t('settings.channelsTabVisible')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="moaretro" data-testid="moa-retro">
        <SettingRow label={t('moa.settings.retro')} description={t('moa.settings.retroDesc')}>
          <Switch
            checked={retro?.enabled ?? false}
            onCheckedChange={(v) => patchRetro({ enabled: v })}
            aria-label={t('moa.settings.retro')}
            disabled={!retro}
            data-testid="moa-retro-switch"
          />
        </SettingRow>
        <SettingRow label={t('moa.settings.retroDay')} description={t('moa.settings.retroWhenDesc')}>
          <MoaSelect
            value={String(retro?.day ?? 1)}
            onChange={(v) => patchRetro({ day: Number(v) })}
            options={dayOptions}
            label={t('moa.settings.retroDay')}
          />
        </SettingRow>
        <SettingRow label={t('moa.settings.retroHour')}>
          <MoaSelect
            value={String(retro?.hour ?? 9)}
            onChange={(v) => patchRetro({ hour: Number(v) })}
            options={hourOptions}
            label={t('moa.settings.retroHour')}
          />
        </SettingRow>
        <SettingRow id="moastats" label={t('moa.settings.stats')} description={t('moa.settings.statsDesc')}>
          <Button variant="destructive" size="md" onClick={clearStats} data-testid="moa-stats-clear">
            {t('moa.settings.statsClear')}
          </Button>
        </SettingRow>
        {statsCleared && (
          <SettingNote data-testid="moa-stats-cleared">{t('moa.settings.statsCleared')}</SettingNote>
        )}
      </SettingsSection>

      <SettingsSection
        id="moamemory"
        title={t('moa.settings.memory')}
        description={t('moa.settings.memoryDesc')}
        data-testid="moa-memory"
      >
        <SettingRow id="moaproposals" label={t('moa.settings.proposals')} description={t('moa.settings.proposalsDesc')}>
          <Switch
            checked={moa?.config.proposals !== false}
            onCheckedChange={(v) => { void patchConfig({ proposals: v }); }}
            aria-label={t('moa.settings.proposals')}
            disabled={!loaded}
            data-testid="moa-proposals"
          />
        </SettingRow>
        {memory !== null && memory.length === 0 && <SettingNote>{t('moa.settings.memoryEmpty')}</SettingNote>}
        {(memory ?? []).map((item) => (
          <SettingRow
            key={`${item.kind}:${item.name}`}
            label={item.name}
            description={`${t(`moa.settings.memoryKind.${item.kind}`)}${item.description ? ` · ${item.description}` : ''}`}
          >
            <Button
              variant="ghost"
              size="md"
              onClick={() => { void onForget(item); }}
              aria-label={t('moa.settings.memoryDelete', { name: item.name })}
              data-testid={`moa-memory-delete-${item.kind}-${item.name}`}
            >
              {t('common.remove')}
            </Button>
          </SettingRow>
        ))}
        {memoryFailed && (
          <SettingNote tone="danger" role="alert">{t('moa.settings.saveFailed')}</SettingNote>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.briefing')}>
        <SettingRow id="briefing" label={t('settings.briefing')} description={t('settings.briefingDesc')}>
          <Switch checked={briefingEnabled} onCheckedChange={onBriefingEnabledChange} aria-label={t('settings.briefing')} />
        </SettingRow>
        <SettingRow label={t('settings.briefingAutoShow')} description={t('settings.briefingAutoShowDesc')}>
          <Switch
            checked={briefingAutoShow}
            onCheckedChange={onBriefingAutoShowChange}
            aria-label={t('settings.briefingAutoShow')}
          />
        </SettingRow>
      </SettingsSection>

      {firstRunOpen && <MoaFirstRunCard onClose={() => setFirstRunOpen(false)} />}
      {archiveOpen && <MoaArchiveDialog onClose={() => setArchiveOpen(false)} />}
    </div>
  );
}

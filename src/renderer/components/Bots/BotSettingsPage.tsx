// ─── A bot's settings page ─────────────────────────────────────────────────
//
// Every setting of one bot, in one place on the Bots page, in place of its
// chat (DESIGN.md › Bots › Bot settings page): the chat header's ⚙ and its
// name pill open it, and so does each bot's row in Settings › Bots. A status
// strip on top (its state and why, today's use, one Pause or Resume), a
// section nav, the sections, and a footer Save.
//
// Form fields (name, picture, job, repository, limits, models, what its
// workers run on, the commands switch) are a draft saved by the footer's
// Save (botSettings.ts settingsSave), disabled until something changed.
// Actions (Pause / Resume, the engine switch, connections, skills, memory,
// New conversation, Stop, Delete bot) act at once, as they always have.
// Leaving with unsaved changes asks first (BotsPage holds the ask).

import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import { FOCUS_RING } from '../focusRing';
import { useStore } from '../../stores';
import { BOT_JOB_MAX, BOT_NAME_MAX, isHermesEngine, isOwnHermesEngine, botTemplate } from '../../../shared/bot';
import { DEFAULT_BOT_WORKER_AGENT, botWorkerAgentLabel, type BotWorkerAgentOption } from '../../../shared/botWorkerAgent';
import type { FactoryBotPort, FactoryBotRow } from '../Room/factoryPorts';
import BotAvatar from '../Room/BotAvatar';
import { PresenceDot, botActionsFor, botPresence } from '../Room/BotChips';
import { botKindLabel } from '../Room/roomFormat';
import { avatarPickError, pickFolderDialog, repoKeyLabel, templateJob } from '../Settings/FactoryTab';
import { routineScheduleText, routineStateText, useBotRoutines } from '../Schedules/BotRoutines';
import { BotEngineLine } from './BotEngineLine';
import { BrainModelFields, WorkerModelFields } from './BotModelLines';
import { BotCommands, getBotCommandPort, useBotCommands } from './BotCommands';
import { BotConnections } from './BotConnections';
import { BotRecipeChecklist } from './BotRecipes';
import { BotSkills } from './BotSkills';
import { BotMemory } from './BotMemory';
import { BotToday, blockerText, workerTimeText } from './BotToday';
import { botBudgetView } from './botBudgetView';
import { CANNOT_DO_MY_HERMES, botCanDo } from './botsProfile';
import { botWakesOn, changedFields, settingsForm, settingsSave, type BotSettingsForm } from './botSettings';
import { InlineConfirm } from './InlineConfirm';
import { DeleteBot, StopBot, useProfilePresenceKey } from './BotsChat';
import type { BotsStopPort } from './botsStop';
import type { BotWorker } from './botsModel';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The bot port verbs the page uses (absent ones show no control). */
export type BotSettingsPort = Partial<Pick<FactoryBotPort, 'update' | 'act' | 'remove' | 'pickAvatar' | 'setAvatar' | 'workerAgents'>>;

export type BotSettingsSection = 'basics' | 'engine' | 'work' | 'limits' | 'connections' | 'memory' | 'canDo' | 'remove';

const SECTIONS: readonly BotSettingsSection[] = ['basics', 'engine', 'work', 'limits', 'connections', 'memory', 'canDo', 'remove'];

/** The sections a bot's page shows: a My Hermes bot starts no wmux workers
 *  and gets no connections, so Work and Connections are left out. Pure. */
export function botSettingsSections(row: FactoryBotRow): BotSettingsSection[] {
  const own = isOwnHermesEngine(row.bot.engine);
  return SECTIONS.filter((s) => !(own && (s === 'work' || s === 'connections')));
}

function Row({ label, htmlFor, hint, children, testId }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <div className="wmux-bot-settings-row" {...(testId ? { 'data-bot-settings-row': testId } : {})}>
      {htmlFor ? <label htmlFor={htmlFor} className="wmux-bot-settings-label">{label}</label> : <span className="wmux-bot-settings-label">{label}</span>}
      <div className="min-w-0 flex-1">
        {children}
        {hint && <div className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{hint}</div>}
      </div>
    </div>
  );
}

/** The status strip: state and what keeps the bot from new work, today's
 *  turns, worker time and workers, and the one Pause / Resume (Turn on for a
 *  bot that is off). */
function StatusStrip({ row, port, t, readOnly }: { row: FactoryBotRow; port: BotSettingsPort; t: T; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const view = botBudgetView(row.bot, row.status);
  const actions = botActionsFor(row);
  const presence = useProfilePresenceKey(row);
  // One state: off, paused by the owner, parked (its reason beside it), or
  // on with its presence.
  const parked = !!row.bot.parked || botPresence(row) === 'parked';
  const pausedByOwner = row.bot.enabled && row.bot.parked?.reason === 'human';
  const state = !row.bot.enabled ? t('botsPage.profile.off')
    : pausedByOwner ? t('botsPage.settings.pausedByYou')
      : parked ? t('room.presence.parked')
        : `${t('botsPage.profile.on')} · ${t(presence)}`;
  const fail = (reason: string) => useStore.getState().pushToast({ message: t('room.bot.actionFailed', { name: row.bot.name, reason }), level: 'error' });
  const run = async (go: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    try {
      const r = await go();
      if (!r.ok) fail(r.message ?? '');
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const act = port.act;
  const update = port.update;
  const button = readOnly ? null
    : !row.bot.enabled ? (update ? { key: 'botsPage.settings.turnOn', id: 'bots-turn-on-bot', go: () => update(row.bot.id, { enabled: true }) } : null)
      : actions.resume ? (act ? { key: 'room.bot.resume', id: 'bots-resume-bot', go: () => act('resume', row.bot.id) } : null)
        : act ? { key: 'botsPage.pause.bot', id: 'bots-pause-bot', go: () => act('park', row.bot.id) } : null;
  const counts: string[] = [];
  // A My Hermes bot starts no wmux workers: its worker limits say nothing.
  const workers = !isOwnHermesEngine(row.bot.engine);
  for (const line of view.lines) {
    if (line.id === 'turnsDay') counts.push(t('botsPage.settings.stripTurns', { used: line.used, max: line.used + line.left }));
    else if (line.id === 'workerTime' && workers) counts.push(t('botsPage.settings.stripWorkerTime', { used: workerTimeText(line.usedMin, t), max: workerTimeText(line.maxMin, t) }));
    else if (line.id === 'workers' && workers) counts.push(t('botsPage.settings.stripWorkers', { used: line.running, max: line.max }));
  }
  return (
    <div className="wmux-bot-settings-strip" role="status">
      <span className="flex items-center gap-1.5 font-[var(--title-weight,500)] text-[var(--text-main)]">
        <PresenceDot presence={botPresence(row)} />
        <span data-bots-profile-state {...(pausedByOwner ? { 'data-bots-profile-parked': 'human' } : {})}>{state}</span>
      </span>
      {view.blocker && !pausedByOwner && (
        <span
          data-bots-profile-blocker={view.blocker.kind}
          {...(row.bot.parked ? { 'data-bots-profile-parked': row.bot.parked.reason } : {})}
          className="text-[var(--text-sub)]"
        >
          {blockerText(view.blocker, row.bot.name, t)}
        </span>
      )}
      {counts.map((c) => <span key={c} className="tabular-nums text-[var(--text-sub)]">{c}</span>)}
      <span className="flex-1" />
      {button && <Button size="sm" variant="secondary" data-testid={button.id} disabled={busy} onClick={() => void run(button.go)}>{t(button.key)}</Button>}
    </div>
  );
}

/** The engines a bot's workers may run on, read once (null until read). */
function useWorkerAgents(list: BotSettingsPort['workerAgents']): BotWorkerAgentOption[] | null {
  const [options, setOptions] = useState<BotWorkerAgentOption[] | null>(null);
  useEffect(() => {
    if (!list) return undefined;
    let live = true;
    list().then((o) => { if (live) setOptions(o); }, () => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [list]);
  return options;
}

export function BotSettingsPage({ row, workers, workspaceName, t, port, stopPort, readOnly = false, onBack, onDirtyChange, leaveAsk, pickFolder = pickFolderDialog }: {
  row: FactoryBotRow;
  /** Its live workers (the strip's count and the profile's Today). */
  workers: readonly BotWorker[];
  workspaceName: string;
  t: T;
  port: BotSettingsPort;
  stopPort: BotsStopPort;
  /** The bots are off: nothing here edits (Delete bot stays). */
  readOnly?: boolean;
  /** Back to the chat (BotsPage asks first when there are unsaved changes). */
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** A leave waiting on the owner's answer: Discard goes, Keep editing stays. */
  leaveAsk: { onDiscard: () => void; onKeep: () => void } | null;
  pickFolder?: () => Promise<string | null>;
}): React.ReactElement {
  const bot = row.bot;
  const id = bot.id;
  const startingJob = templateJob(botTemplate(bot), t);
  const commandsView = useBotCommands(id);
  const commands = commandsView?.available ? commandsView.enabled : null;
  const base = useMemo(() => settingsForm(bot, startingJob, commands), [bot, startingJob, commands]);
  const [edits, setEdits] = useState<Partial<BotSettingsForm>>({});
  const form: BotSettingsForm = { ...base, ...edits };
  const dirty = changedFields(base, edits).length > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const edit = (patch: Partial<BotSettingsForm>) => setEdits((cur) => ({ ...cur, ...patch }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sections = botSettingsSections(row);
  const ownHermes = isOwnHermesEngine(bot.engine);
  const workerOptions = useWorkerAgents(sections.includes('work') ? port.workerAgents : undefined);
  const routines = (useBotRoutines()?.routines ?? []).filter((r) => r.botId === id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<BotSettingsSection>('basics');

  const save = async () => {
    const plan = settingsSave(bot, base, form, startingJob, t);
    if (!plan.ok) { setError(plan.error); return; }
    setSaving(true);
    setError(null);
    try {
      // The profile first: a refused profile saves no picture either.
      if (Object.keys(plan.patch).length > 0) {
        if (!port.update) return;
        const r = await port.update(id, plan.patch);
        if (!r.ok) { setError(r.message || t('settings.factory.saveFailed')); return; }
      }
      setEdits(({ picture, commands: c }) => ({ ...(picture !== undefined ? { picture } : {}), ...(c !== undefined ? { commands: c } : {}) }));
      if (plan.picture !== undefined && port.setAvatar) {
        const r = await port.setAvatar(id, plan.picture);
        if (!r.ok) { setError(r.message || t('settings.factory.saveFailed')); return; }
      }
      setEdits(({ commands: c }) => (c !== undefined ? { commands: c } : {}));
      if (plan.commands !== undefined) {
        const r = await getBotCommandPort().setEnabled({ botId: id, enabled: plan.commands });
        if (!r.ok) { setError(r.error); return; }
      }
      setEdits({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pickPicture = async () => {
    if (!port.pickAvatar) return;
    try {
      const r = await port.pickAvatar();
      if (r.ok) { edit({ picture: r.avatar }); setError(null); } else { const msg = avatarPickError(r, t); if (msg) setError(msg); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const pickRepo = async () => {
    try {
      const folder = await pickFolder();
      if (folder) edit({ repoFolder: folder });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // The nav marks the section at the top of the scroll; a click scrolls to it.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // Scrolled to the end: the last section, however short.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { setActive(sections[sections.length - 1]); return; }
    let current: BotSettingsSection = sections[0];
    for (const s of sections) {
      const sec = el.querySelector<HTMLElement>(`[data-bot-settings-section="${s}"]`);
      if (sec && sec.getBoundingClientRect().top - top <= 24) current = s;
    }
    setActive(current);
  };
  const goTo = (s: BotSettingsSection) => {
    setActive(s);
    scrollRef.current?.querySelector<HTMLElement>(`[data-bot-settings-section="${s}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const shownAvatar = form.picture === undefined ? bot.avatar : form.picture ?? undefined;
  const ownJob = !!bot.job;
  const canDo = botCanDo(bot);
  const update = readOnly ? undefined : port.update;
  const currentAgent = bot.workerAgent?.agent ?? '';
  const listedAgents = (workerOptions ?? []).filter((o) => o.agent !== DEFAULT_BOT_WORKER_AGENT || o.agent === form.workerAgent);
  const agentChoices = form.workerAgent && !listedAgents.some((o) => o.agent === form.workerAgent)
    ? [...listedAgents, { agent: form.workerAgent, label: botWorkerAgentLabel(form.workerAgent), installed: false, supported: true }]
    : currentAgent && !listedAgents.some((o) => o.agent === currentAgent)
      ? [...listedAgents, { agent: currentAgent, label: botWorkerAgentLabel(currentAgent), installed: false, supported: true }]
      : listedAgents;
  const agentText = (o: BotWorkerAgentOption): string => {
    if (!o.supported) return t('botsPage.profile.workersUnavailable', { name: o.label });
    return o.installed ? o.label : t('botsPage.profile.workersNotInstalled', { name: o.label });
  };
  const heading = (s: BotSettingsSection) => <h3 className="wmux-bot-settings-heading">{t(`botsPage.settings.section.${s}`)}</h3>;

  return (
    <section className="wmux-bots-chat wmux-bot-settings" data-bot-settings={id} aria-label={t('botsPage.settings.title', { name: bot.name })}>
      <div className="wmux-bots-chat-head wmux-bot-settings-head">
        <button type="button" data-bot-settings-back onClick={onBack} aria-label={t('botsPage.settings.back')} title={t('botsPage.settings.back')} className={`wmux-bots-back wmux-bot-settings-back ${FOCUS_RING}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9,2.5 4.5,7 9,11.5" /></svg>
        </button>
        <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{bot.name}</span>
        <span className="shrink-0 text-[13px] text-[var(--text-muted)]">{`· ${t('botsPage.settings.short')}`}</span>
      </div>
      <StatusStrip row={row} port={port} t={t} readOnly={readOnly} />
      <div className="wmux-bot-settings-body">
        <nav className="wmux-bot-settings-nav" aria-label={t('botsPage.settings.sections')}>
          {sections.map((s) => (
            <button key={s} type="button" data-bot-settings-nav={s} aria-current={active === s ? 'true' : undefined} onClick={() => goTo(s)} className={`wmux-bot-settings-nav-item ${FOCUS_RING}`}>
              {t(`botsPage.settings.section.${s}`)}
            </button>
          ))}
        </nav>
        <div ref={scrollRef} className="wmux-bot-settings-scroll" onScroll={onScroll} data-bots-profile={id}>
          <fieldset disabled={readOnly || saving} className="wmux-bot-settings-form">
            <section data-bot-settings-section="basics" className="wmux-bot-settings-section">
              {heading('basics')}
              <Row label={t('settings.factory.botName')} htmlFor="bot-settings-name">
                <div className="flex items-center gap-3">
                  <span data-testid="factory-picture-preview" className="inline-flex shrink-0"><BotAvatar bot={{ ...bot, avatar: shownAvatar }} size={30} t={t} /></span>
                  <Input id="bot-settings-name" data-testid="bot-settings-name" value={form.name} maxLength={BOT_NAME_MAX} onChange={(e) => edit({ name: e.target.value })} className="min-w-0 flex-1 text-[13px]" />
                </div>
                {port.pickAvatar && port.setAvatar && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Button size="sm" variant="secondary" data-testid="factory-picture-choose" onClick={() => void pickPicture()}>{t('settings.factory.changePicture')}</Button>
                    {shownAvatar && <Button size="sm" variant="ghost" data-testid="factory-picture-remove" onClick={() => edit({ picture: null })}>{t('settings.factory.removePicture')}</Button>}
                  </div>
                )}
              </Row>
              <Row
                label={t('botsPage.profile.job')}
                htmlFor="bot-settings-job"
                testId="job"
                hint={<span data-bots-profile-job-default={ownJob ? undefined : ''}>{ownJob || !startingJob ? t('botsPage.settings.jobHint') : t('botsPage.settings.jobStarting', { template: botKindLabel(bot, t) })}</span>}
              >
                <textarea
                  id="bot-settings-job"
                  data-testid="bots-profile-job-input"
                  value={form.job}
                  rows={4}
                  maxLength={BOT_JOB_MAX}
                  placeholder={t('botsPage.profile.noJob')}
                  onChange={(e) => edit({ job: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={`w-full rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-main)] outline-none ${FOCUS_RING}`}
                />
              </Row>
              <Row label={t('botsPage.profile.workspace')}><span data-bot-settings-workspace className="wmux-bot-settings-value">{workspaceName}</span></Row>
              <Row label={t('botsPage.profile.repo')} testId="repo" hint={bot.repo ? undefined : <span data-bots-profile-repo-hint>{t('botsPage.profile.repoHint')}</span>}>
                <div className="flex min-w-0 items-center gap-2 text-[13px]" data-bots-profile-repo>
                  <span data-bots-profile-repo-key className="wmux-bot-settings-value min-w-0 truncate" title={form.repoFolder ?? bot.repo?.repoPath}>
                    {form.repoFolder ?? (bot.repo ? repoKeyLabel(bot.repo.repoKey) : t('botsPage.profile.noRepo'))}
                  </span>
                  <Button size="sm" variant="ghost" data-testid="bots-profile-repo-change" onClick={() => void pickRepo()}>
                    {t(bot.repo || form.repoFolder ? 'settings.factory.addBotChangeFolder' : 'settings.factory.addBotChooseFolder')}
                  </Button>
                </div>
              </Row>
            </section>

            <section data-bot-settings-section="engine" className="wmux-bot-settings-section">
              {heading('engine')}
              <BotEngineLine row={row} t={t} />
              <Row label={t('botsPage.models.thinksOn')}>
                <BrainModelFields engine={bot.engine} model={form.brainModel} effort={form.brainEffort} onModel={(m) => edit({ brainModel: m })} onEffort={(e) => edit({ brainEffort: e })} t={t} />
              </Row>
            </section>

            {sections.includes('work') && (
              <section data-bot-settings-section="work" className="wmux-bot-settings-section">
                {heading('work')}
                <Row label={t('botsPage.profile.workersRunOn')} htmlFor="bot-settings-workers-engine">
                  <Select
                    id="bot-settings-workers-engine"
                    data-testid="bots-profile-workers-engine"
                    value={form.workerAgent}
                    disabled={!port.workerAgents || workerOptions === null}
                    onChange={(e) => edit({ workerAgent: e.target.value, workerModel: '', workerEffort: '' })}
                  >
                    <option value="">{t('botsPage.profile.workersDefault', { name: botWorkerAgentLabel(DEFAULT_BOT_WORKER_AGENT) })}</option>
                    {agentChoices.map((o) => <option key={o.agent} value={o.agent} disabled={!o.installed || !o.supported}>{agentText(o)}</option>)}
                  </Select>
                </Row>
                <Row label={t('botsPage.models.workerModel')}>
                  <WorkerModelFields agent={form.workerAgent} model={form.workerModel} effort={form.workerEffort} onModel={(m) => edit({ workerModel: m })} onEffort={(e) => edit({ workerEffort: e })} t={t} />
                </Row>
                <BotCommands row={row} t={t} {...(form.commands !== null ? { enabled: form.commands } : {})} onEnabledChange={(v) => edit({ commands: v })} />
                <Row label={t('botsPage.settings.wakesOn')} testId="wakes">
                  <p data-bot-settings-wakes className="wmux-bot-settings-value">{botWakesOn(bot.triggers).map((k) => t(k)).join(' · ')}</p>
                  {routines.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[12px]" data-bots-profile-routines>
                      {routines.map((r) => (
                        <li key={r.id} data-bot-routine={r.id} className={`truncate ${r.state !== 'active' ? 'text-[var(--text-muted)]' : 'text-[var(--text-sub)]'}`}>
                          {`${r.title} · ${routineScheduleText(r.schedule)} · ${routineStateText(r)}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </Row>
              </section>
            )}

            <section data-bot-settings-section="limits" className="wmux-bot-settings-section">
              {heading('limits')}
              {([
                ['perDay', 'settings.factory.turnsPerDay', undefined],
                ['perHour', 'settings.factory.turnsPerHour', t('settings.factory.noHourlyLimit')],
                ['workers', 'settings.factory.workers', undefined],
              ] as const).filter(([key]) => !(ownHermes && key === 'workers')).map(([key, label, placeholder]) => (
                <Row key={key} label={t(label)} htmlFor={`bot-settings-${key}`}>
                  <div className="w-[120px]">
                    <Input
                      id={`bot-settings-${key}`}
                      data-testid={`bot-settings-${key}`}
                      type="number"
                      min={0}
                      value={form[key]}
                      {...(placeholder ? { placeholder } : {})}
                      onChange={(e) => edit({ [key]: e.target.value })}
                      className="text-[13px]"
                    />
                  </div>
                </Row>
              ))}
              {!ownHermes && <p className="text-[11px] text-[var(--text-muted)]">{t('botsPage.settings.limitsHint', { time: workerTimeText(Math.round(bot.budget.maxWorkerHoursPerDay * 60), t) })}</p>}
              <BotToday row={row} act={update ? port.act : undefined} liveWorkers={workers.length} t={t} underStrip workerLines={!ownHermes} />
            </section>

            {sections.includes('connections') && (
              <section data-bot-settings-section="connections" className="wmux-bot-settings-section">
                {heading('connections')}
                <BotRecipeChecklist bot={bot} t={t} />
                <BotConnections row={row} t={t} />
              </section>
            )}

            <section data-bot-settings-section="memory" className="wmux-bot-settings-section">
              {heading('memory')}
              <BotSkills row={row} t={t} />
              <BotMemory row={row} t={t} />
            </section>

            <section data-bot-settings-section="canDo" className="wmux-bot-settings-section" data-bots-profile-can-do>
              {heading('canDo')}
              <ul className="space-y-0.5 text-[13px] text-[var(--text-main)]">
                {canDo.map((key) => <li key={key} data-can-do={key}>{t(key)}</li>)}
              </ul>
              {ownHermes && <p data-cannot-do className="text-[12px] text-[var(--text-muted)]">{t(CANNOT_DO_MY_HERMES)}</p>}
              {!ownHermes && isHermesEngine(bot.engine) && <p className="text-[12px] text-[var(--text-muted)]">{t('botsPage.hermes.canDo')}</p>}
            </section>
          </fieldset>

          <section data-bot-settings-section="remove" className="wmux-bot-settings-section wmux-bot-settings-form">
            {heading('remove')}
            {!readOnly && <StopBot row={row} port={stopPort} t={t} />}
            <DeleteBot row={row} port={port.remove ? { remove: port.remove } : undefined} t={t} />
          </section>
        </div>
      </div>
      {!readOnly && (
        <div className="wmux-bot-settings-foot" data-bot-settings-foot>
          {leaveAsk ? (
            <div className="w-full">
              <InlineConfirm
                text={t('botsPage.settings.leaveConfirm', { name: bot.name })}
                confirmLabel={t('botsPage.settings.discard')}
                cancelLabel={t('botsPage.settings.keepEditing')}
                busy={false}
                onConfirm={leaveAsk.onDiscard}
                onCancel={leaveAsk.onKeep}
                testId="bot-settings-leave"
                tone="primary"
              />
            </div>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-[12px] text-[var(--text-muted)]">
                {error ? <span role="alert" className="text-[var(--accent-red)]">{error}</span> : t('botsPage.settings.applyNext')}
              </span>
              <Button size="sm" variant="ghost" data-testid="bot-settings-cancel" disabled={!dirty || saving} onClick={() => { setEdits({}); setError(null); }}>{t('settings.factory.cancel')}</Button>
              <Button size="sm" variant="primary" data-testid="bot-settings-save" disabled={!dirty || saving || !port.update} onClick={() => void save()}>{t('settings.factory.save')}</Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

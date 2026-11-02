// ─── A bot's settings page: its form and what wakes it (pure) ──────────────
//
// The page (BotSettingsPage.tsx) edits a draft of the bot's own fields and
// saves them with one Save: one bot.update patch (name, job, repository
// folder, limits, its own model and effort, what its workers run on and
// their model), then the picture (setAvatar) and the commands switch
// (factory.commands.setEnabled) — the same calls the profile and the
// Settings row used, in the order the Settings row saved them (a refused
// profile saves no picture). The draft holds only what the owner changed,
// over the bot as main reports it now, so a change main makes meanwhile
// (the bot rewrites its job) shows until the owner edits that field.

import { normalizeBotName, type BotProfile, type BotTrigger } from '../../../shared/bot';
import type { BotProfilePatch } from '../Room/factoryPorts';
import { brainEngine, unusableBrainModel, workerAgentPick } from './botsProfile';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface BotSettingsForm {
  name: string;
  /** The job box: the bot's own job, else its starting job. */
  job: string;
  /** A picked folder not saved yet (null: unchanged). */
  repoFolder: string | null;
  /** undefined: unchanged; a string: the new picture; null: remove it. */
  picture: string | null | undefined;
  perHour: string;
  perDay: string;
  workers: string;
  brainModel: string;
  brainEffort: string;
  /** '' = the default agent. */
  workerAgent: string;
  workerModel: string;
  workerEffort: string;
  /** The commands switch; null where the bot runs no commands. */
  commands: boolean | null;
}

/** The form as the bot stands now. `startingJob`: its template's job in the
 *  owner's language ('' for none); `commands`: the switch main reports. */
export function settingsForm(bot: BotProfile, startingJob: string, commands: boolean | null): BotSettingsForm {
  const engine = bot.engine;
  const sdk = engine.kind === 'claude-sdk';
  const w = bot.workerAgent;
  return {
    name: bot.name,
    job: bot.job ?? startingJob,
    repoFolder: null,
    picture: undefined,
    perHour: bot.budget.maxTurnsPerHour === undefined ? '' : String(bot.budget.maxTurnsPerHour),
    perDay: String(bot.budget.maxTurnsPerDay),
    workers: String(bot.budget.maxConcurrentWorkers),
    // A stored model main would not pass on opens empty (main keeps it when
    // Save sends none).
    brainModel: sdk && unusableBrainModel(engine) === null ? engine.model?.trim() ?? '' : '',
    brainEffort: sdk ? engine.effort ?? '' : '',
    workerAgent: w?.agent ?? '',
    workerModel: w?.model ?? '',
    workerEffort: w?.effort ?? '',
    commands,
  };
}

/** The fields the owner changed from `base`. Pure. */
export function changedFields(base: BotSettingsForm, edits: Partial<BotSettingsForm>): Array<keyof BotSettingsForm> {
  return (Object.keys(edits) as Array<keyof BotSettingsForm>).filter((k) => edits[k] !== base[k]);
}

/** A whole number ≥ 0 typed in a limit box, else undefined. Pure. */
function count(v: string): number | undefined {
  const s = v.trim();
  return s !== '' && /^\d+$/.test(s) ? Number(s) : undefined;
}

export type SettingsSave =
  | { ok: true; patch: BotProfilePatch; picture?: string | null; commands?: boolean }
  | { ok: false; error: string };

/** What Save sends for the owner's changes: the bot.update patch (only the
 *  changed fields), the picture and the commands switch. A field main would
 *  refuse is refused here first, in the owner's words. Pure but for `t`. */
export function settingsSave(bot: BotProfile, base: BotSettingsForm, form: BotSettingsForm, startingJob: string, t: T): SettingsSave {
  const changed = new Set(changedFields(base, form as Partial<BotSettingsForm>));
  const patch: BotProfilePatch = {};
  if (changed.has('name')) {
    const name = normalizeBotName(form.name);
    if (!name) return { ok: false, error: t('botsPage.settings.nameInvalid') };
    if (name !== bot.name) patch.name = name;
  }
  if (changed.has('job')) {
    const job = form.job.trim();
    // Empty, or the starting job as shown: the bot works on its starting
    // job (no job of its own).
    const next = job === '' || (startingJob !== '' && job === startingJob.trim()) ? null : job;
    if (next !== (bot.job ?? null)) patch.job = next;
  }
  if (changed.has('repoFolder') && form.repoFolder) patch.repoFolder = form.repoFolder;
  const budget: NonNullable<BotProfilePatch['budget']> = {};
  if (changed.has('perHour')) {
    if (form.perHour.trim() !== '' && count(form.perHour) === undefined) return { ok: false, error: t('botsPage.settings.limitInvalid') };
    // Empty (or 0) removes the hourly cap.
    const hour = count(form.perHour);
    const next = hour === undefined || hour === 0 ? null : hour;
    if (next !== (bot.budget.maxTurnsPerHour ?? null)) budget.maxTurnsPerHour = next;
  }
  if (changed.has('perDay')) {
    const day = count(form.perDay);
    if (day === undefined) return { ok: false, error: t('botsPage.settings.limitInvalid') };
    budget.maxTurnsPerDay = day;
  }
  if (changed.has('workers')) {
    const workers = count(form.workers);
    if (workers === undefined) return { ok: false, error: t('botsPage.settings.limitInvalid') };
    budget.maxConcurrentWorkers = workers;
  }
  if (Object.keys(budget).length > 0) patch.budget = budget;
  // Its own model and effort only on Claude, and only when changed, so a
  // Save never undoes an engine switch made on this page.
  if (bot.engine.kind === 'claude-sdk' && (changed.has('brainModel') || changed.has('brainEffort'))) {
    const next = brainEngine(form.brainModel, form.brainEffort);
    if (!next.ok) return { ok: false, error: t('botsPage.models.invalidBrain', { model: next.model }) };
    patch.engine = next.engine;
  }
  if (changed.has('workerAgent') || changed.has('workerModel') || changed.has('workerEffort')) {
    const next = workerAgentPick(form.workerAgent, form.workerModel, form.workerEffort);
    if (!next.ok) return { ok: false, error: next.model !== undefined ? t('botsPage.models.invalid', { model: next.model }) : next.error };
    patch.workerAgent = next.workerAgent;
  }
  return {
    ok: true,
    patch,
    ...(changed.has('picture') ? { picture: form.picture ?? null } : {}),
    ...(changed.has('commands') && form.commands !== null ? { commands: form.commands } : {}),
  };
}

/** What wakes the bot, in the owner's words: its messages and handoffs
 *  always (they wake their addressee whatever its triggers), then one phrase
 *  per kind of fact its triggers name, in a fixed order. Pure. */
export const WAKE_PHRASES: ReadonlyArray<{ key: string; prefixes: readonly string[] }> = [
  { key: 'botsPage.settings.wake.pr', prefixes: ['pr.'] },
  { key: 'botsPage.settings.wake.ci', prefixes: ['ci.'] },
  { key: 'botsPage.settings.wake.issue', prefixes: ['issue.'] },
  { key: 'botsPage.settings.wake.review', prefixes: ['verdict.', 'merge.'] },
  { key: 'botsPage.settings.wake.workers', prefixes: ['task.', 'pane.'] },
  { key: 'botsPage.settings.wake.correction', prefixes: ['human.correction'] },
  { key: 'botsPage.settings.wake.bots', prefixes: ['bot.'] },
  { key: 'botsPage.settings.wake.schedule', prefixes: ['schedule.'] },
];

export function botWakesOn(triggers: readonly BotTrigger[]): string[] {
  const kinds = triggers.map((tr) => tr.kind as string);
  return ['botsPage.settings.wake.messages', ...WAKE_PHRASES.filter((p) => kinds.some((k) => p.prefixes.some((pre) => k.startsWith(pre)))).map((p) => p.key)];
}

// ─── The Bots profile's model pickers ──────────────────────────────────────
//
// "Thinks on": the bot's own model and effort (its claude-sdk engine).
// "Worker model": the model and effort of the workers it starts, on the
// agent the "Workers run on" line picks (workerAgent). Each shows its value
// with Change, which opens the model combobox (the catalog's models, free
// text allowed) and an effort select; Save refuses a model id that main
// would refuse (botsProfile.ts brainEngine / workerAgentPick) before main
// checks it again. A saved model of the bot's own that main would not pass
// on shows as the default model, with a warning.

import { useEffect, useState } from 'react';
import Button from '../ui/Button';
import Select from '../ui/Select';
import { FOCUS_RING } from '../focusRing';
import { ModelCombobox } from '../Settings/ModelCombobox';
import { effortChoicesFor } from '../Settings/SettingsPanel';
import { CLAUDE_EFFORT_LEVELS } from '../../../shared/claudeModels';
import { CATALOG_AGENTS, staticClaudeModels, type CatalogModel } from '../../../shared/modelCatalog';
import { DEFAULT_BOT_WORKER_AGENT } from '../../../shared/botWorkerAgent';
import type { FactoryBotPort, FactoryBotRow } from '../Room/factoryPorts';
import { botModelName, brainEngine, unusableBrainModel, workerAgentPick } from './botsProfile';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The models an agent's CLI offers: Claude's static list, else the
 *  catalog main discovers (empty until it answers; free text still works). */
function useAgentModels(agent: string): CatalogModel[] {
  const [models, setModels] = useState<CatalogModel[]>(() => (agent === DEFAULT_BOT_WORKER_AGENT ? staticClaudeModels() : []));
  useEffect(() => {
    if (agent === DEFAULT_BOT_WORKER_AGENT) { setModels(staticClaudeModels()); return undefined; }
    setModels([]);
    const list = window.electronAPI?.agentModels?.list;
    if (!list || !(CATALOG_AGENTS as readonly string[]).includes(agent)) return undefined;
    let live = true;
    list(agent).then((r) => { if (live) setModels(r.models); }, () => undefined);
    return () => { live = false; };
  }, [agent]);
  return models;
}

/** One model + effort line. `save` resolves to null once saved, else the
 *  message to show; absent = read-only. */
function ModelPickLine({ label, testId, shown, warning, model0, effort0, models, efforts, save, t }: {
  label: string;
  testId: string;
  shown: string;
  /** Shown under the value while not editing. */
  warning?: string;
  model0: string;
  effort0: string;
  models: readonly CatalogModel[];
  efforts: (model: string) => readonly string[];
  save?: (model: string, effort: string) => Promise<string | null>;
  t: T;
}) {
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(model0);
  const [effort, setEffort] = useState(effort0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!save) return;
    setBusy(true);
    setError(null);
    try {
      const message = await save(model, effort);
      if (message === null) setEditing(false);
      else setError(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const choices = efforts(model);
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-testid={testId}>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <div className="flex items-center gap-1.5">
              <ModelCombobox
                value={model}
                onChange={setModel}
                models={models}
                aria-label={t('botsPage.models.model')}
                placeholder={t('botsPage.models.defaultModel')}
                className="text-[12px]"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Select data-testid={`${testId}-effort`} aria-label={t('botsPage.models.effort')} value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">{t('botsPage.models.defaultEffort')}</option>
                {(choices.includes(effort) || !effort ? choices : [...choices, effort]).map((e) => <option key={e} value={e}>{e}</option>)}
              </Select>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>{t('settings.factory.cancel')}</Button>
              <Button size="sm" variant="primary" data-testid={`${testId}-save`} disabled={busy} onClick={() => void run()}>{t('settings.factory.save')}</Button>
            </div>
            {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
          </>
        ) : (
          <>
            <span data-testid={`${testId}-value`} className="text-[var(--text-main)]">{shown}</span>
            {save && (
              <button
                type="button"
                data-testid={`${testId}-edit`}
                onClick={() => { setModel(model0); setEffort(effort0); setError(null); setEditing(true); }}
                className={`ml-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
              >
                {t('botsPage.models.change')}
              </button>
            )}
            {warning && <p data-testid={`${testId}-warning`} className="mt-1 text-[11px] text-[var(--accent-yellow)]">{warning}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function shownModel(agent: string, model: string | undefined, effort: string | undefined, t: T): string {
  const name = model ? botModelName(agent, model) : t('botsPage.models.defaultModel');
  return effort ? `${name} · ${t('botsPage.models.effortValue', { effort })}` : name;
}

const CLAUDE_EFFORTS = (): readonly string[] => CLAUDE_EFFORT_LEVELS;

/** The bot's own model and effort. Another engine than claude-sdk shows
 *  that it has none to pick here. */
export function BrainModelLine({ row, t, port }: { row: FactoryBotRow; t: T; port?: Pick<FactoryBotPort, 'update'> }) {
  const engine = row.bot.engine;
  const models = useAgentModels(DEFAULT_BOT_WORKER_AGENT);
  const label = t('botsPage.models.thinksOn');
  if (engine.kind !== 'claude-sdk') {
    return <ModelPickLine label={label} testId="bots-profile-brain" shown={t('botsPage.models.otherEngine')} model0="" effort0="" models={[]} efforts={() => []} t={t} />;
  }
  const unusable = unusableBrainModel(engine);
  const update = port?.update;
  const save = update
    ? async (model: string, effort: string): Promise<string | null> => {
      const next = brainEngine(model, effort);
      if (!next.ok) return t('botsPage.models.invalidBrain', { model: next.model });
      const r = await update(row.bot.id, { engine: next.engine });
      return r.ok ? null : r.message || t('botsPage.models.saveFailed');
    }
    : undefined;
  return (
    <ModelPickLine
      key={`${engine.model ?? ''}:${engine.effort ?? ''}`}
      label={label}
      testId="bots-profile-brain"
      shown={shownModel(DEFAULT_BOT_WORKER_AGENT, unusable === null ? engine.model : undefined, engine.effort, t)}
      {...(unusable !== null ? { warning: t('botsPage.models.storedInvalid', { model: unusable }) } : {})}
      model0={engine.model ?? ''}
      effort0={engine.effort ?? ''}
      models={models}
      efforts={CLAUDE_EFFORTS}
      {...(save ? { save } : {})}
      t={t}
    />
  );
}

/** The model and effort of the bot's workers, on the agent they run on. */
export function WorkerModelLine({ row, t, port }: { row: FactoryBotRow; t: T; port?: Pick<FactoryBotPort, 'update'> }) {
  const w = row.bot.workerAgent;
  const agent = w?.agent ?? DEFAULT_BOT_WORKER_AGENT;
  const models = useAgentModels(agent);
  const update = port?.update;
  const save = update
    ? async (model: string, effort: string): Promise<string | null> => {
      const next = workerAgentPick(w?.agent ?? '', model, effort);
      if (!next.ok) return next.model !== undefined ? t('botsPage.models.invalid', { model: next.model }) : next.error;
      const r = await update(row.bot.id, { workerAgent: next.workerAgent });
      return r.ok ? null : r.message || t('botsPage.models.saveFailed');
    }
    : undefined;
  return (
    <ModelPickLine
      key={`${agent}:${w?.model ?? ''}:${w?.effort ?? ''}`}
      label={t('botsPage.models.workerModel')}
      testId="bots-profile-worker-model"
      shown={shownModel(agent, w?.model, w?.effort, t)}
      model0={w?.model ?? ''}
      effort0={w?.effort ?? ''}
      models={models}
      efforts={(model) => effortChoicesFor({ agent, model }, models)}
      {...(save ? { save } : {})}
      t={t}
    />
  );
}

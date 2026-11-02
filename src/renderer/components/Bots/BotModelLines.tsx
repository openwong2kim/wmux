// ─── A bot's settings page: its model pickers ──────────────────────────────
//
// "Thinks on": the bot's own model and effort (its claude-sdk engine).
// "Worker model": the model and effort of the workers it starts, on the
// agent "Workers run on" picks (workerAgent). Each is the model combobox
// (the catalog's models, free text allowed) and an effort select, fields of
// the page's form: its Save refuses a model id main would refuse
// (botSettings.ts settingsSave) before main checks it again. A saved model of
// the bot's own that main would not pass on shows a warning and the box
// opens empty; main keeps that model when Save sends none.

import { useEffect, useState } from 'react';
import Select from '../ui/Select';
import { ModelCombobox } from '../Settings/ModelCombobox';
import { effortChoicesFor } from '../Settings/SettingsPanel';
import { CLAUDE_EFFORT_LEVELS } from '../../../shared/claudeModels';
import { CATALOG_AGENTS, staticClaudeModels, type CatalogModel } from '../../../shared/modelCatalog';
import { DEFAULT_BOT_WORKER_AGENT } from '../../../shared/botWorkerAgent';
import { isHermesEngine, isOwnHermesEngine, type BotEngine } from '../../../shared/bot';
import { unusableBrainModel } from './botsProfile';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The models an agent's CLI offers: Claude's static list, else the
 *  catalog main discovers (empty until it answers; free text still works). */
export function useAgentModels(agent: string): CatalogModel[] {
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

/** One model box and one effort select, controlled by the page's form. */
function ModelFields({ testId, model, effort, models, efforts, onModel, onEffort, warning, t }: {
  testId: string;
  model: string;
  effort: string;
  models: readonly CatalogModel[];
  efforts: readonly string[];
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  warning?: string;
  t: T;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ModelCombobox
          value={model}
          onChange={onModel}
          models={models}
          aria-label={t('botsPage.models.model')}
          placeholder={t('botsPage.models.defaultModel')}
          className="text-[13px]"
          style={{ flex: '1 1 12rem', minWidth: '12rem' }}
        />
        <Select data-testid={`${testId}-effort`} aria-label={t('botsPage.models.effort')} value={effort} onChange={(e) => onEffort(e.target.value)}>
          <option value="">{t('botsPage.models.defaultEffort')}</option>
          {(efforts.includes(effort) || !effort ? efforts : [...efforts, effort]).map((e) => <option key={e} value={e}>{e}</option>)}
        </Select>
      </div>
      {warning && <p data-testid={`${testId}-warning`} className="text-[11px] text-[var(--accent-yellow)]">{warning}</p>}
    </div>
  );
}

/** The bot's own model and effort: on Claude, the fields; on Hermes, the
 *  model set in that Hermes; on any other engine, one line that it has none
 *  to pick here. */
export function BrainModelFields({ engine, model, effort, onModel, onEffort, t }: {
  engine: BotEngine;
  model: string;
  effort: string;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  t: T;
}) {
  const models = useAgentModels(DEFAULT_BOT_WORKER_AGENT);
  if (engine.kind !== 'claude-sdk') {
    const shown = isOwnHermesEngine(engine) ? t('botsPage.models.myHermesModel') : isHermesEngine(engine) ? t('botsPage.models.hermesModel') : t('botsPage.models.otherEngine');
    return <span data-testid="bots-profile-brain-value" className="wmux-bot-settings-value">{shown}</span>;
  }
  const unusable = unusableBrainModel(engine);
  return (
    <ModelFields
      testId="bots-profile-brain"
      model={model}
      effort={effort}
      models={models}
      efforts={CLAUDE_EFFORT_LEVELS}
      onModel={onModel}
      onEffort={onEffort}
      {...(unusable !== null ? { warning: t('botsPage.models.storedInvalid', { model: unusable }) } : {})}
      t={t}
    />
  );
}

/** The model and effort of the bot's workers, on `agent` ('' = default). */
export function WorkerModelFields({ agent, model, effort, onModel, onEffort, t }: {
  agent: string;
  model: string;
  effort: string;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  t: T;
}) {
  const slug = agent || DEFAULT_BOT_WORKER_AGENT;
  const models = useAgentModels(slug);
  return (
    <ModelFields
      testId="bots-profile-worker-model"
      model={model}
      effort={effort}
      models={models}
      efforts={effortChoicesFor({ agent: slug, model }, models)}
      onModel={onModel}
      onEffort={onEffort}
      t={t}
    />
  );
}

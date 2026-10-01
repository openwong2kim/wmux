// ─── Model catalog: types + pure parsers ─────────────────────────────────────
//
// What each agent CLI reports it can run, so the role-binding model field can
// offer real ids instead of free text only. Pure (no node/electron imports):
// main owns the spawning and caching (src/main/agents/ModelCatalog.ts), the
// renderer only reads the result.
//
// Sources, verified 2026-09-30:
//   agy    `agy models`          → "Fetching available models..." then
//                                   `<id>\t<label>` lines (agy 1.2.x). The
//                                   effort is part of the id (`-low|-medium|-high`).
//   codex  `codex debug models`  → JSON `{ models: [{ slug, display_name,
//                                   visibility, default_reasoning_level,
//                                   supported_reasoning_levels: [{ effort }] }] }`
//                                   (codex-cli 0.159.2; a debug subcommand, so
//                                   parsing is defensive and never throws).
//   claude no list command        → the static list in shared/claudeModels.

import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_OPTIONS } from './claudeModels';

export interface CatalogModel {
  /** Exact value for the agent's model flag. */
  id: string;
  /** Human label as the CLI prints it. */
  label: string;
  /** Effort levels this model accepts, when the CLI reports them. */
  efforts?: string[];
}

export type ModelCatalogStatus = 'ok' | 'static' | 'unavailable';

export interface ModelCatalogResult {
  agent: string;
  /** ok = discovered from the CLI; static = built-in list; unavailable = the
   *  CLI could not be run or its output could not be parsed. */
  status: ModelCatalogStatus;
  models: CatalogModel[];
  /** Epoch ms of the discovery (or of the failed attempt). */
  fetchedAt: number;
}

/** Agents with a discovery source (static or CLI). */
export const CATALOG_AGENTS = ['claude', 'codex', 'agy'] as const;

const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;

/** agy's effort is encoded in the id suffix: `gemini-3.8-flash-low` → `low`. */
export function agyEffortOf(id: string): string | undefined {
  return AGY_EFFORT_SUFFIX.exec(id)?.[1];
}

/** agy model id without its effort suffix (the "family"). */
export function agyFamilyOf(id: string): string {
  return id.replace(AGY_EFFORT_SUFFIX, '');
}

/** Parse `agy models` output. Lines that are not `<id>\t<label>` are skipped. */
export function parseAgyModels(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const [id, label] = raw.split('\t');
    if (!id || label === undefined || !/^[A-Za-z0-9._-]{1,64}$/.test(id.trim())) continue;
    const trimmed = id.trim();
    out.push({ id: trimmed, label: label.trim() || trimmed });
  }
  return out;
}

/** Parse `codex debug models` JSON. Hidden models are dropped. */
export function parseCodexModels(text: string): CatalogModel[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const models = (data as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: CatalogModel[] = [];
  for (const m of models as Record<string, unknown>[]) {
    const id = typeof m?.slug === 'string' ? m.slug : '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) continue;
    if (m.visibility !== undefined && m.visibility !== 'list') continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as { effort?: unknown }[])
          .map((l) => l?.effort)
          .filter((e): e is string => typeof e === 'string' && /^[a-z]{1,16}$/.test(e))
      : [];
    out.push({
      id,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : id,
      ...(efforts.length ? { efforts } : {}),
    });
  }
  return out;
}

/** The built-in Claude list (no discovery command exists). */
export function staticClaudeModels(): CatalogModel[] {
  return CLAUDE_MODEL_OPTIONS.filter((o) => o.value).map((o) => ({
    id: o.value,
    label: o.label,
    efforts: [...CLAUDE_EFFORT_LEVELS],
  }));
}

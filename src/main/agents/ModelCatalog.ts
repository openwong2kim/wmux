// ─── ModelCatalog: discover each agent CLI's models, cached ──────────────────
//
// Runs the discovery command of an agent CLI (see shared/modelCatalog for the
// verified grammar), keeps the result in memory and in
// `<wmux dir>/model-catalog.json`, and never throws: a missing CLI, a timeout
// or unparsable output becomes `status: 'unavailable'` so Settings simply
// falls back to free text.
//
// Discovery is lazy — it runs when Settings asks, never at app startup — and
// `agy models` goes to the network, so results live for CACHE_TTL_MS and a
// failure is retried only after FAILURE_TTL_MS.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { runCli } from '../../shared/runCli';
import {
  parseAgyModels,
  parseCodexModels,
  staticClaudeModels,
  type CatalogModel,
  type ModelCatalogResult,
} from '../../shared/modelCatalog';

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FAILURE_TTL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface Source {
  command: string;
  args: string[];
  parse: (stdout: string) => CatalogModel[];
}

const SOURCES: Record<string, Source> = {
  agy: { command: 'agy', args: ['models'], parse: parseAgyModels },
  codex: { command: 'codex', args: ['debug', 'models'], parse: parseCodexModels },
};

export interface ModelCatalogDeps {
  /** Run a CLI and resolve stdout. Defaults to runCli. */
  run?: (command: string, args: string[]) => Promise<string>;
  now?: () => number;
  /** Cache file; defaults to `<wmux dir>/model-catalog.json`. */
  cachePath?: string;
}

/** A discovery source for this agent, own keys only: `constructor` or
 *  `__proto__` must never resolve to something on Object.prototype. */
function sourceFor(agent: string): Source | undefined {
  return Object.hasOwn(SOURCES, agent) ? SOURCES[agent] : undefined;
}

const EFFORT_RE = /^[a-z]{1,16}$/;

function isCatalogModel(m: unknown): m is CatalogModel {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return false;
  const { id, label, efforts } = m as Record<string, unknown>;
  if (typeof id !== 'string' || typeof label !== 'string') return false;
  return efforts === undefined || (Array.isArray(efforts) && efforts.every((e) => typeof e === 'string' && EFFORT_RE.test(e)));
}

/** A persisted entry, re-checked on read: model-catalog.json is a plain file in
 *  the wmux dir, and a hand-edited `models: "x"` or an entry without an id would
 *  otherwise crash the Settings combobox. Only successes are ever persisted, so
 *  anything else is dropped and simply re-discovered. */
function validCachedEntry(agent: string, raw: unknown): ModelCatalogResult | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { status, models, fetchedAt } = raw as Record<string, unknown>;
  if (status !== 'ok' || typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return undefined;
  if (!Array.isArray(models) || !models.every(isCatalogModel)) return undefined;
  return { agent, status, models, fetchedAt };
}

export class ModelCatalog {
  private readonly run: (command: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  private readonly cachePath: string;
  // A Map, not a plain object: agent names come from the renderer and the file.
  private cache: Map<string, ModelCatalogResult> | null = null;
  private readonly inflight = new Map<string, Promise<ModelCatalogResult>>();

  constructor(deps: ModelCatalogDeps = {}) {
    this.run =
      deps.run ??
      ((command, args) =>
        runCli(command, args, { timeoutMs: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }));
    this.now = deps.now ?? Date.now;
    this.cachePath = deps.cachePath ?? path.join(getWmuxDir(), 'model-catalog.json');
  }

  /** Models for one agent. `refresh` skips the cache (the Settings button). */
  async list(agent: string, opts: { refresh?: boolean } = {}): Promise<ModelCatalogResult> {
    if (agent === 'claude') {
      return { agent, status: 'static', models: staticClaudeModels(), fetchedAt: this.now() };
    }
    const source = sourceFor(agent);
    if (!source) return { agent, status: 'unavailable', models: [], fetchedAt: this.now() };

    if (!opts.refresh) {
      const cached = this.readCache().get(agent);
      if (cached && this.fresh(cached)) return cached;
    }
    const pending = this.inflight.get(agent);
    if (pending) return pending;
    const job = this.discover(agent, source).finally(() => this.inflight.delete(agent));
    this.inflight.set(agent, job);
    return job;
  }

  private fresh(entry: ModelCatalogResult): boolean {
    const ttl = entry.status === 'ok' ? CACHE_TTL_MS : FAILURE_TTL_MS;
    return this.now() - entry.fetchedAt < ttl;
  }

  private async discover(agent: string, source: Source): Promise<ModelCatalogResult> {
    // One retry: the first discovery after launch was seen to fail once
    // (agy, 2026-09-30) and succeed seconds later with nothing changed.
    let models: CatalogModel[] = [];
    for (let attempt = 0; attempt < 2 && models.length === 0; attempt++) {
      try {
        models = source.parse(await this.run(source.command, source.args));
      } catch {
        models = [];
      }
    }
    const result: ModelCatalogResult = {
      agent,
      status: models.length > 0 ? 'ok' : 'unavailable',
      models,
      fetchedAt: this.now(),
    };
    const cache = this.readCache();
    cache.set(agent, result);
    // Only successes are persisted; a failure is remembered in memory for
    // FAILURE_TTL_MS, so a restart always tries again. A failed write only
    // costs a re-discovery next launch.
    if (result.status === 'ok') {
      const persisted = Object.fromEntries([...cache].filter(([, v]) => v.status === 'ok'));
      await atomicWriteJSON(this.cachePath, persisted).catch(() => undefined);
    }
    return result;
  }

  private readCache(): Map<string, ModelCatalogResult> {
    if (this.cache) return this.cache;
    const loaded = new Map<string, ModelCatalogResult>();
    try {
      const raw = atomicReadJSONSync<unknown>(this.cachePath);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [agent, entry] of Object.entries(raw)) {
          const valid = sourceFor(agent) ? validCachedEntry(agent, entry) : undefined;
          if (valid) loaded.set(agent, valid);
        }
      }
    } catch {
      loaded.clear();
    }
    this.cache = loaded;
    return loaded;
  }
}

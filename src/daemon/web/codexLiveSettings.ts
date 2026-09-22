import { createHash } from 'node:crypto';
import path from 'node:path';

export type CodexSettingsMethod = 'thread/read' | 'model/list' | 'thread/settings/update';
export type CodexSettingsRPC = (method: CodexSettingsMethod, params: Record<string, unknown>) => Promise<unknown>;
export interface CodexPaneBinding { threadId: string; cwd: string }
export interface LiveModelChoice { model: string; efforts: string[]; defaultEffort: string }
export interface LiveAgentSettings { agent: 'codex'; model: string; effort: string | null; busy: boolean; revision: string; models: LiveModelChoice[] }
export class LiveSettingsError extends Error {
  constructor(readonly reason: 'unavailable' | 'stale' | 'busy' | 'unsupported-choice' | 'unconfirmed') { super(reason); }
}
const efforts = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveSettingsError('unavailable');
  return value as Record<string, unknown>;
}
async function current(rpc: CodexSettingsRPC, binding: CodexPaneBinding) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.threadId) || !path.isAbsolute(binding.cwd)) throw new LiveSettingsError('unavailable');
  const response = object(await rpc('thread/read', {threadId:binding.threadId,includeTurns:false}));
  const thread = object(response.thread);
  const status = object(thread.status).type;
  if (thread.id !== binding.threadId || typeof thread.cwd !== 'string' || path.resolve(thread.cwd) !== path.resolve(binding.cwd) ||
      !['idle','active','systemError'].includes(String(status)) || typeof thread.model !== 'string' || !token.test(thread.model) ||
      !(thread.reasoningEffort === null || typeof thread.reasoningEffort === 'string' && efforts.has(thread.reasoningEffort))) {
    throw new LiveSettingsError('unavailable');
  }
  const model = thread.model;
  const effort = thread.reasoningEffort as string | null;
  const revision = createHash('sha256').update(JSON.stringify([binding.threadId,binding.cwd,model,effort])).digest('hex');
  return {model,effort,busy:status === 'active',revision};
}
async function catalog(rpc: CodexSettingsRPC): Promise<LiveModelChoice[]> {
  const models: LiveModelChoice[] = [];
  const seenModels = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const response = object(await rpc('model/list', {limit:100,includeHidden:false,...(cursor === undefined ? {} : {cursor})}));
    if (!Array.isArray(response.data) || response.data.length > 100) throw new LiveSettingsError('unavailable');
    for (const value of response.data) {
      const row = object(value);
      if (row.hidden === true) continue;
      if (typeof row.model !== 'string' || !token.test(row.model) || !Array.isArray(row.supportedReasoningEfforts) ||
          typeof row.defaultReasoningEffort !== 'string' || !efforts.has(row.defaultReasoningEffort)) throw new LiveSettingsError('unavailable');
      const supported = row.supportedReasoningEfforts.map(value => object(value).reasoningEffort);
      if (!supported.every(value => typeof value === 'string' && efforts.has(value)) || !supported.includes(row.defaultReasoningEffort)) {
        throw new LiveSettingsError('unavailable');
      }
      if (seenModels.has(row.model)) throw new LiveSettingsError('unavailable');
      seenModels.add(row.model);
      models.push({model:row.model,efforts:[...new Set(supported as string[])],defaultEffort:row.defaultReasoningEffort});
    }
    if (response.nextCursor == null) return models;
    if (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0 ||
        response.nextCursor.length > 4096 || seenCursors.has(response.nextCursor)) throw new LiveSettingsError('unavailable');
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  // Never advertise a truncated catalog as complete or allow writes against it.
  throw new LiveSettingsError('unavailable');
}

/** Binding comes from the daemon's owned live TUI relay, never from the phone.
 * No resume/start/config-write method exists on this interface. */
export async function readCodexLiveSettings(rpc: CodexSettingsRPC, binding: CodexPaneBinding): Promise<LiveAgentSettings> {
  const state = await current(rpc,binding);
  const models = await catalog(rpc);
  return {agent:'codex',...state,models};
}

/** Optimistic stale-view protection, not a server-side CAS with other Codex clients.
 * Confirmation is a fresh runtime read; an acknowledgement alone is insufficient. */
export async function updateCodexLiveSettings(rpc: CodexSettingsRPC, binding: CodexPaneBinding,
  choice: {model:string;effort:string;expectedRevision:string}, mayWrite: () => boolean): Promise<LiveAgentSettings> {
  const models = await catalog(rpc);
  if (!models.some(model => model.model === choice.model && model.efforts.includes(choice.effort))) throw new LiveSettingsError('unsupported-choice');
  const before = await current(rpc,binding);
  if (before.revision !== choice.expectedRevision) throw new LiveSettingsError('stale');
  if (before.busy) throw new LiveSettingsError('busy');
  if (!mayWrite()) throw new LiveSettingsError('unavailable');
  try {
    await rpc('thread/settings/update', {threadId:binding.threadId,model:choice.model,effort:choice.effort});
    const after = await current(rpc,binding);
    if (after.model !== choice.model || after.effort !== choice.effort || !mayWrite()) throw new LiveSettingsError('unconfirmed');
    return {agent:'codex',...after,models};
  } catch { throw new LiveSettingsError('unconfirmed'); }
}

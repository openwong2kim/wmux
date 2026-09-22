import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { ENV_KEYS, isBrainPty } from '../../shared/constants';
import type { HookAgentEventData } from '../hooks/HookIngest';

export interface RunHistoryEntry {
  id: string;
  sessionId: string;
  workspace: string;
  agent: string;
  outcome: 'completed' | 'failed' | 'interrupted';
  at: number;
  summary: string;
}
interface ActiveRun { sessionId: string; workspace: string; agent: string; startedAt: number }
interface HistoryFile { version: 1; entries: RunHistoryEntry[]; active: ActiveRun[] }
const CAP = 1000;
// eslint-disable-next-line no-control-regex
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Authoritative hook outcomes, independent of the phone's connection lifetime. */
export class RunHistoryStore {
  private entries: RunHistoryEntry[] = [];
  private active = new Map<string, ActiveRun>();
  private readonly file: string;
  private dirty = false;
  constructor(directory: string) {
    this.file = path.join(directory, 'phone-run-history.json');
    let value: HistoryFile | undefined;
    let failure: unknown;
    for (const candidate of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(candidate)) continue;
      try {
        if (fs.statSync(candidate).size > 4 * 1024 * 1024) throw new Error('run history exceeds size limit');
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as HistoryFile;
        if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.active)) throw new Error('invalid run history');
        value = parsed;
        this.dirty = candidate !== this.file;
        break;
      } catch (error) { failure = error; }
    }
    if (!value) {
      if (failure) throw failure;
      return;
    }
    this.entries = value.entries.filter(e => e && typeof e.id === 'string' && typeof e.sessionId === 'string' &&
      typeof e.workspace === 'string' && typeof e.agent === 'string' && typeof e.summary === 'string' &&
      Number.isFinite(e.at) && ['completed','failed','interrupted'].includes(e.outcome)).slice(-CAP);
    for (const a of value.active.slice(-256)) {
      if (a && typeof a.sessionId === 'string' && typeof a.workspace === 'string' && typeof a.agent === 'string' && Number.isFinite(a.startedAt)) {
        this.active.set(a.sessionId, a);
      }
    }
  }

  list(offset = 0, limit = 100) {
    if (this.dirty) this.save();
    const newest = [...this.entries].reverse();
    const entries = newest.slice(offset, offset + limit);
    return { entries, nextOffset: offset + entries.length < newest.length ? offset + entries.length : null };
  }

  ingest(sessionId: string, env: Record<string,string>, data: HookAgentEventData) {
    if (isBrainPty({id:sessionId,env})) return;
    const kind = data.signal.kind;
    if (data.source !== 'hook') return;
    const at = Number.isFinite(data.signal.ts) ? data.signal.ts : Date.now();
    const workspace = clean(env[ENV_KEYS.WORKSPACE_NAME] ?? env[ENV_KEYS.WORKSPACE_ID] ?? '', 160);
    const agent = clean(data.agent, 80);
    if (data.status === 'running' && ['agent.activity','agent.tool_started','agent.user_prompt_submit'].includes(kind)) {
      if (!this.active.has(sessionId) && this.active.size < 256) {
        this.active.set(sessionId, {sessionId,workspace,agent,startedAt:at});
        this.save();
      }
      return;
    }
    const outcome = kind === 'agent.stop_failure' && data.status === 'error' ? 'failed'
      : kind === 'agent.stop' && data.status === 'complete' ? 'completed' : null;
    if (!outcome || ['internal','veto','pending'].includes(data.decision ?? '')) return;
    const id = createHash('sha256').update(JSON.stringify([sessionId,data.signal.agentSessionId,kind,at])).digest('hex');
    if (this.entries.some(e => e.id === id)) {
      if (this.dirty) this.save();
      return;
    }
    this.active.delete(sessionId);
    const reported = data.signal.payload.last_assistant_message;
    const summary = outcome === 'completed' && typeof reported === 'string' && reported.trim() ? reported : data.message;
    this.append({id,sessionId,workspace,agent,outcome,at,summary:clean(summary,600)});
  }

  reconcileLiveSessions(live: ReadonlySet<string>) {
    for (const id of [...this.active.keys()]) {
      if (!live.has(id)) this.interrupted(id);
    }
  }

  interrupted(sessionId: string, at = Date.now()) {
    const active = this.active.get(sessionId);
    if (!active) return; // A shell exit after a completed turn is not a failure.
    this.active.delete(sessionId);
    const id = createHash('sha256').update(JSON.stringify([sessionId,active.startedAt,'interrupted'])).digest('hex');
    if (!this.entries.some(e => e.id === id)) {
      this.append({id,sessionId,workspace:active.workspace,agent:active.agent,outcome:'interrupted',at,
        summary:'The pane ended before an authoritative completion signal.'});
    }
  }

  private append(entry: RunHistoryEntry) {
    this.entries.push(entry);
    this.entries = this.entries.slice(-CAP);
    this.save();
  }
  private save() {
    this.dirty = true;
    atomicWriteJSONSync(this.file, {version:1,entries:this.entries,active:[...this.active.values()]}, {durable:true});
    this.dirty = false;
  }
}

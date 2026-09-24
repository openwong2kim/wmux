import { createHash } from 'node:crypto';
import { readCodexLiveSettings, updateCodexLiveSettings } from '../../../daemon/web/codexLiveSettings';
import path from 'node:path';
import { loadChatSkills } from '../../../daemon/transcript/chatSkills';
import { connectCodexSettings } from '../../../daemon/web/codexSettingsTransport';
import { agentDisplayToSlug } from '../../../shared/agentIdentity';
import type { ChatSkillCatalog } from '../../../shared/transcript/chatSkills';
import type { TranscriptStatus } from '../../../shared/transcript/turnEvents';

type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface Pane { id: string; pid: number; incarnationId: string; cwd: string; state: string; wslTarget?: unknown; env?: Record<string, string> }
const unavailable: ChatSkillCatalog = { skills: [], state: 'unavailable' };

/** Read-only rolling-upgrade path. Keeps a pre-existing daemon and its PTYs alive.
 * Never falls back for authorization, transport or catalogue errors. */
function captureScope(rpc: Rpc, id: string, agent: string) {
  return async () => {
    const [rows, status, live] = await Promise.all([
      rpc('daemon.listSessions', {}), rpc('daemon.transcript.status', { id }), rpc('daemon.getAgentState', { id }),
    ]);
    const pane = Array.isArray(rows) ? rows.find((row: Pane) => row.id === id) as Pane | undefined : undefined;
    const transcript = status as TranscriptStatus;
    const slug = agentDisplayToSlug((live as { agentName?: string })?.agentName ?? '');
    if (!pane || pane.wslTarget || !['attached', 'detached'].includes(pane.state) ||
      !Number.isSafeInteger(pane.pid) || typeof pane.incarnationId !== 'string' || !pane.incarnationId ||
      typeof pane.cwd !== 'string' || !path.isAbsolute(pane.cwd) || pane.cwd.includes('\0') ||
      slug && slug !== agent || transcript?.managed) throw new Error('Unavailable scope');
    const nativeSessionId = transcript?.terminal?.nativeSessionId ?? transcript?.agentSessionId;
    if (slug && (transcript?.agentAlive !== true || transcript?.terminal?.agent !== agent || !nativeSessionId)) throw new Error('Unverified agent');
    const env: Record<string, string> = {};
    for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
      const value = pane.env?.[name];
      if (value !== undefined) {
        if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Invalid account');
        env[name] = value;
      }
    }
    return { pid: pane.pid, incarnationId: pane.incarnationId, cwd: pane.cwd, state: pane.state, env, slug, nativeSessionId };
  };
}

export async function compatibleChatSkills(rpc: Rpc, id: string, agent: string): Promise<ChatSkillCatalog> {
  const capture = captureScope(rpc, id, agent);
  try {
    const scope = await capture();
    let cwd = scope.cwd;
    if (agent === 'codex' && scope.nativeSessionId) {
      const connection = await connectCodexSettings({ cwd, codeHome: scope.env.CODEX_HOME });
      try {
        const result = await connection.rpc('thread/read', { threadId: scope.nativeSessionId, includeTurns: false }) as { thread?: { id?: string; cwd?: string } };
        if (result.thread?.id !== scope.nativeSessionId || typeof result.thread.cwd !== 'string' || !path.isAbsolute(result.thread.cwd) || result.thread.cwd.includes('\0')) return unavailable;
        cwd = result.thread.cwd;
      } finally { connection.close(); }
    }
    const result = await loadChatSkills(agent, cwd, scope.env);
    return JSON.stringify(await capture()) === JSON.stringify(scope) ? result : unavailable;
  } catch { return unavailable; }
}


export async function compatibleCodexSettings(rpc: Rpc, id: string, choice?: { model: string; effort: string; expectedRevision: string }) {
  const capture = captureScope(rpc, id, 'codex');
  const scope = await capture();
  if (scope.slug !== 'codex' || !scope.nativeSessionId) throw new Error('unavailable');
  const scopeKey = JSON.stringify(scope);
  const prefix = createHash('sha256').update(scopeKey).digest('hex') + '.';
  if (choice && !choice.expectedRevision.startsWith(prefix)) throw new Error('stale');
  const connection = await connectCodexSettings({ cwd: scope.cwd, codeHome: scope.env.CODEX_HOME });
  let valid = true;
  const guarded: typeof connection.rpc = async (method, params) => {
    valid = JSON.stringify(await capture()) === scopeKey;
    if (!valid) throw new Error('stale');
    const result = await connection.rpc(method, params);
    valid = JSON.stringify(await capture()) === scopeKey;
    if (!valid) throw new Error(method === 'thread/settings/update' ? 'unconfirmed' : 'stale');
    return result;
  };
  try {
    const response = await guarded('thread/read', { threadId: scope.nativeSessionId, includeTurns: false }) as { thread?: { id?: string; cwd?: string } };
    if (response.thread?.id !== scope.nativeSessionId || typeof response.thread.cwd !== 'string' || !path.isAbsolute(response.thread.cwd)) throw new Error('unavailable');
    const binding = { threadId: scope.nativeSessionId, cwd: response.thread.cwd };
    const result = choice
      ? await updateCodexLiveSettings(guarded, binding, { ...choice, expectedRevision: choice.expectedRevision.slice(prefix.length) }, () => valid)
      : await readCodexLiveSettings(guarded, binding);
    return { ...result, revision: prefix + result.revision };
  } finally { connection.close(); }
}

import { validTerminalLaunchMode } from '../../shared/transcript/terminalChat';
import { runCli } from '../../shared/runCli';
import { stripWmuxNamespace } from '../web/webPaneEnv';

/** Environment for the shared Codex runtime server. That server outlives the pane
 * that starts it and parents shell commands and MCP servers for every Codex pane on
 * the account, so it carries no WMUX_* key at all: not a pane identity, and not
 * WMUX_DATA_SUFFIX either (the server is per account, not per wmux instance, so a
 * suffix would point every Codex thread at whichever instance started it first).
 * Pane identity and the instance suffix are supplied per thread instead. */
export function codexRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defined: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') defined[k] = v;
  return stripWmuxNamespace(defined);
}
/** Quote an initial instruction for the verified POSIX shell.
 * Never accept controls, terminal escapes or a caller-supplied launcher. */
export function terminalLaunchCommand(agent: unknown, prompt: unknown, mode: unknown = 'default'): string {
  if (!validTerminalLaunchMode(agent, mode) || (agent !== 'claude' && agent !== 'codex') || typeof prompt !== 'string' ||
      !prompt.trim() || prompt.length > 2000 || [...prompt].some(c => c.charCodeAt(0) < 32 && c !== '\n' || c.charCodeAt(0) === 127)) {
    throw new Error('Invalid initial message');
  }
  const flags = mode === 'bypass' ? ' --dangerously-skip-permissions' : mode === 'yolo' ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  return agent + flags + " -- '" + prompt.replace(/'/g, "'\\''") + "'";
}

const startingAccounts = new Map<string, Promise<void>>();
/** Official idempotent native runtime startup, not a managed conversation.
 * Never restart/stop an existing account server or enable remote control. */
export async function startNativeCodexRuntime(env: NodeJS.ProcessEnv): Promise<void> {
  const key = env.CODEX_HOME ?? env.HOME ?? '';
  const existing = startingAccounts.get(key);
  if (existing) return existing;
  if (startingAccounts.size >= 8) throw new Error('Too many runtime starts');
  const task = new Promise<void>((resolve, reject) => {
    // Stripped here too so no caller can seed wmux state into the shared server.
    // runCli resolves an npm codex.cmd shim on Windows, which execFile cannot (#1619).
    runCli('codex', ['app-server', 'daemon', 'start'], { env: codexRuntimeEnv(env), timeoutMs: 15000, maxBuffer: 64000 })
      .then(() => resolve(), () => reject(new Error('Native Codex runtime unavailable')));
  });
  startingAccounts.set(key, task);
  try { await task; } finally { startingAccounts.delete(key); }
}

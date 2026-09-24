import { validTerminalLaunchMode } from '../../shared/transcript/terminalChat';
import { execFile } from 'node:child_process';
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
    execFile('codex', ['app-server', 'daemon', 'start'], { env, timeout: 15000, maxBuffer: 64000, windowsHide: true },
      error => error ? reject(new Error('Native Codex runtime unavailable')) : resolve());
  });
  startingAccounts.set(key, task);
  try { await task; } finally { startingAccounts.delete(key); }
}

import path from 'node:path';
import { validTerminalLaunchMode } from '../../shared/transcript/terminalChat';
import { runCli } from '../../shared/runCli';
import { stripWmuxNamespace } from '../web/webPaneEnv';
import { CHATV2_PROVIDER_SESSION_ID } from '../../shared/chatv2/ipc';
import { resumeGrammarFor, toResumeCommand } from '../../shared/agentResume';
import type { ResumeShell } from '../chat/v2/handoff';

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
 * Never accept controls, terminal escapes or a caller-supplied launcher.
 * `undefined` launches the agent with no first message (a blank string is
 * still refused). `resume` continues the newest conversation in the shell's
 * directory: Claude `--continue`, Codex `resume --last` (whose first
 * positional after `--last` is the prompt). Every token is fixed. */
export function terminalLaunchCommand(agent: unknown, prompt: unknown, mode: unknown = 'default', resume = false): string {
  if (!validTerminalLaunchMode(agent, mode) || (agent !== 'claude' && agent !== 'codex') || (prompt !== undefined && (typeof prompt !== 'string' ||
      !prompt.trim() || prompt.length > 2000 || [...prompt].some(c => c.charCodeAt(0) < 32 && c !== '\n' || c.charCodeAt(0) === 127)))) {
    throw new Error('Invalid initial message');
  }
  const head = !resume ? agent : agent === 'codex' ? 'codex resume --last' : 'claude --continue';
  const flags = mode === 'bypass' ? ' --dangerously-skip-permissions' : mode === 'yolo' ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  return head + flags + (prompt === undefined ? '' : " -- '" + prompt.replace(/'/g, "'\\''") + "'");
}

/** The cwd forms each shell's resume line takes: a POSIX absolute path, or a Windows one. */
// eslint-disable-next-line no-control-regex -- refusing controls is the point
const CONTROL = /[\0-\x1f\x7f]/;
export function resumeCwdUsable(cwd: string, shell: ResumeShell): boolean {
  if (!cwd || CONTROL.test(cwd)) return false;
  return shell === 'pwsh' ? path.win32.isAbsolute(cwd) && /^[A-Za-z]:[\\/]/.test(cwd)
    : path.posix.isAbsolute(cwd) && !/['\\\u2018-\u201b]/.test(cwd);
}

/** Resume EXACTLY `sessionId` (Claude `--resume <id>`, Codex `resume <id>`) with the request's own
 * mode and first message, through the same rewrite the desktop resume uses. Never a stored
 * permission mode. The caller places the folder (`inResumeCwd`, or a relay's `--cd`).
 * Every token is fixed or pattern-checked. PowerShell takes no first message: Windows
 * PowerShell, and pwsh calling a .cmd shim, pass native arguments without escaping inner
 * quotes, so no quoting can keep a prompt one argument there. */
export function boundResumeCommand(agent: unknown, sessionId: string, prompt: unknown, mode: unknown, shell: ResumeShell): string {
  if (!CHATV2_PROVIDER_SESSION_ID.test(sessionId) || (agent !== 'claude' && agent !== 'codex')) throw new Error('Invalid session');
  if (shell === 'pwsh' && prompt !== undefined) throw new Error('No first message under PowerShell');
  const launch = terminalLaunchCommand(agent, prompt, mode);
  // Pane folder = binding folder, so the rewrite takes its exact-session branch.
  const line = toResumeCommand(launch, { agent, sessionId, cwd: '/', ts: 0 }, '/');
  const exact = resumeGrammarFor(agent)?.withId(sessionId);
  if (!exact || !line.startsWith(`${agent} ${exact}`)) throw new Error('Not an exact resume');
  return line;
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

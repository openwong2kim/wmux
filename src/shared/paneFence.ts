// ─── A person's pane in the worker fence: what main and the renderer share ──
//
// main/agents/paneFence.ts launches an opted-in pane's claude inside the
// worker fence; the renderer keeps the pane's switch and shows its state.

import { AGENT_ROWS, agentLauncherStem } from './agentIdentity';
import { launcherStem, tokenize } from './agentResume';
import { splitModelEnvMarker } from './workerLaunch';

/** What pty:create and pty:write-launch report for a fenced pane: the
 *  switch is on, and whether an agent launch was fenced just now. */
export interface PaneFenceState {
  on: boolean;
  launched: boolean;
}

/** Every refusal of a fenced launch carries this, after the IPC prefix. */
export const PANE_FENCE_REFUSAL_MARK = 'worker fence: ';

/** The refusal's own sentence from an error message, or null when the error
 *  is not a fence refusal. Pure. */
export function paneFenceRefusalReason(message: string): string | null {
  const at = message.indexOf(PANE_FENCE_REFUSAL_MARK);
  return at < 0 ? null : message.slice(at + PANE_FENCE_REFUSAL_MARK.length).trim() || null;
}

/** Programs that run another program: a line starting with one starts claude
 *  (if at all) where the fence's flag cannot be put. */
export const WRAPPER_STEMS: ReadonlySet<string> = new Set([
  'env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox',
  'exec', 'command', 'builtin', 'eval', 'source', '.', 'nohup', 'nice', 'sudo', 'doas', 'su', 'time', 'timeout',
  'stdbuf', 'xargs', 'script', 'caffeinate', 'npx', 'bunx', 'pnpx', 'cmd', 'powershell', 'pwsh', 'wsl',
  // Others that run the command they are given.
  'watch', 'find', 'parallel', 'entr', 'unbuffer', 'flock', 'ionice', 'taskset', 'chrt', 'setsid', 'tmux', 'screen',
]);

const AGENT_STEMS: ReadonlySet<string> = new Set(AGENT_ROWS.map(agentLauncherStem));

/** Shell words before a command word that are not the command. */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'coproc', 'time', 'fi', 'done', 'esac']);
/** A redirection word, alone (`2>`, its target next) or with its target (`>log`). */
const REDIRECT = /^\d*(?:&>>?|>&|<&|<>|>>?|<<?<?)/;

/** A word's command stem, cut at a redirection written onto it (`claude>log`). */
function stemOf(word: string): string {
  return launcherStem(word.split(/[<>]/)[0]);
}

/** The line split into simple commands: at `;`, `&`, `|`, newlines, braces
 *  and parentheses outside quotes, and at every command substitution (`$(`,
 *  a backtick), which the shell runs inside double quotes too. Pure. */
function simpleCommands(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`' || (c === '$' && line[i + 1] === '(')) {
      out.push(cur);
      cur = '';
      if (c === '$') i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (/[;&|\r\n(){}]/.test(c)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * The agents a shell line starts (their launcher stems, `claude`, `codex`,
 * ...): an agent at a command word of any simple command in it (after
 * `VAR=value` words), and behind a wrapper (`command`, `nice -n 5`,
 * `sh -c "..."`) any later word naming one, or a quoted argument that starts
 * one. A word that only mentions an agent (`ask codex to check`, `echo
 * claude`) starts none. Over-matching behind a wrapper is the safe side.
 * Pure.
 */
export function paneLineAgents(line: string, depth = 0): string[] {
  if (depth > 4) return [];
  const found: string[] = [];
  for (const cmd of simpleCommands(splitModelEnvMarker(line.trim()).command)) {
    const tokens = tokenize(cmd);
    // The command word: past `VAR=value`, shell keywords and redirections.
    let first = 0;
    while (first < tokens.length) {
      const v = tokens[first].value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v) || SHELL_KEYWORDS.has(v)) first += 1;
      else if (REDIRECT.test(v)) first += v.replace(REDIRECT, '').length === 0 ? 2 : 1;
      else break;
    }
    if (first >= tokens.length) continue;
    const stem = stemOf(tokens[first].value);
    if (AGENT_STEMS.has(stem)) {
      found.push(stem);
      continue;
    }
    if (!WRAPPER_STEMS.has(stem)) continue;
    for (const t of tokens.slice(first + 1)) {
      const later = stemOf(t.value);
      if (AGENT_STEMS.has(later)) found.push(later);
      else if (/[\s;&|`$(){}]/.test(t.value)) found.push(...paneLineAgents(t.value, depth + 1));
    }
  }
  return [...new Set(found)];
}

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../shared/runCli';
import type { AgentSlug } from '../../shared/agentIdentity';
import { agentExecEnv, LOGIN_PATH_RETRY_MS, resolveLoginShellPath } from '../../shared/execEnv';

// TODO(#1904): option discovery parses these two CLIs' `--help`; another agent
// needs its own parser before it can join.
type WebLaunchAgent = Extract<AgentSlug, 'claude' | 'codex'>;
export interface AgentLaunchChoice { agent: WebLaunchAgent; model?: string; effort?: string }
export interface AgentLaunchOptions { agent: WebLaunchAgent; models: string[]; efforts: string[]; modelEfforts?: Record<string,string[]>; catalogState?: 'cached' | 'unavailable' }
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Discover CLI flags without starting an agent turn or contacting a model API. */
export function claudeOptionsFromHelp(help: string): AgentLaunchOptions | null {
  if (!help.includes('--model') || !help.includes('Claude Code')) return null;
  const effortLine = help.match(/--effort[\s\S]{0,160}?\(([^)]+)\)/)?.[1] ?? '';
  return { agent: 'claude', models: MODELS.filter(model => model !== 'fable' || /\bfable\b/.test(help)),
    efforts: EFFORTS.filter(level => effortLine.split(/[,\s]+/).includes(level)) };
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const CODEX_EFFORTS = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
export function codexOptionsFromCache(value: unknown, now = Date.now()): AgentLaunchOptions {
  const empty: AgentLaunchOptions = {agent:'codex',models:[],efforts:[],modelEfforts:{},catalogState:'unavailable'};
  if (!value || typeof value !== 'object') return empty;
  const cache = value as {fetched_at?:unknown;models?:unknown};
  const fetched = typeof cache.fetched_at === 'string' ? Date.parse(cache.fetched_at) : NaN;
  if (!Number.isFinite(fetched) || fetched > now + 60000 || now - fetched > 86400000 || !Array.isArray(cache.models)) return empty;
  const modelEfforts: Record<string,string[]> = {};
  for (const row of cache.models.slice(0,100)) {
    if (!row || row.visibility !== 'list' || typeof row.slug !== 'string' || !TOKEN.test(row.slug) ||
        ['__proto__','constructor','prototype'].includes(row.slug) || !Array.isArray(row.supported_reasoning_levels)) continue;
    modelEfforts[row.slug] = [...new Set<string>(row.supported_reasoning_levels.flatMap((level: {effort?: unknown}) =>
      typeof level?.effort === 'string' && CODEX_EFFORTS.has(level.effort) ? [level.effort] : []))];
  }
  return {agent:'codex',models:Object.keys(modelEfforts),efforts:[],modelEfforts,catalogState:'cached'};
}
async function codexOptions(env: NodeJS.ProcessEnv): Promise<AgentLaunchOptions> {
  const file = path.join(env.CODEX_HOME || path.join(os.homedir(),'.codex'),'models_cache.json');
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return codexOptionsFromCache(null);
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
    const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
    if (bytesRead > 4 * 1024 * 1024) return codexOptionsFromCache(null);
    return codexOptionsFromCache(JSON.parse(buffer.toString('utf8',0,bytesRead)));
  } catch { return codexOptionsFromCache(null); }
  finally { await handle?.close(); }
}
interface Probe { help: string; bin?: string }
interface ProbedClis { at: number; ttl: number; path: string; claude: Probe; codex: Probe }
let helpCache: ProbedClis | undefined;
let helpLoading: Promise<ProbedClis> | undefined;
/** First executable `name` on `searchPath`, as the shell's own lookup would find it. */
export async function whichOnPath(name: string, searchPath: string): Promise<string | undefined> {
  for (const dir of searchPath.split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      await fs.access(file, constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch { /* not here */ }
  }
  return undefined;
}
// A Finder-launched daemon inherits launchd's /usr/bin:/bin:/usr/sbin:/sbin, so the
// probe resolves each CLI on the login shell's PATH plus the per-user/Homebrew
// fallbacks, and remembers the absolute binary so the launch runs that same one.
async function help(command: string, env: NodeJS.ProcessEnv): Promise<Probe> {
  const bin = process.platform === 'win32' ? command : await whichOnPath(command, env.PATH ?? '');
  if (!bin) return {help:''};
  // runCli, not execFile: on Windows an npm-installed codex is a .cmd shim that
  // execFile cannot find, so it was reported as not installed (#1619).
  return runCli(bin, ['--help'], { env, timeoutMs: 3000, maxBuffer: 128 * 1024 })
    .then((stdout) => ({help:stdout, ...(bin === command ? {} : {bin})}), () => ({help:''}));
}
async function installedHelp(): Promise<ProbedClis> {
  if (helpCache && Date.now() - helpCache.at < helpCache.ttl) return helpCache;
  if (helpLoading) return helpLoading;
  helpLoading = (async () => {
    try {
      const loginOk = process.platform === 'win32' || await resolveLoginShellPath() !== null;
      const env = await agentExecEnv(process.env);
      const [claude,codex] = await Promise.all([help('claude',env),help('codex',env)]);
      // A failed login-shell probe may be why a CLI is missing; do not pin that for 5 minutes.
      helpCache = {at:Date.now(),ttl:loginOk ? 300000 : LOGIN_PATH_RETRY_MS,path:env.PATH ?? '',claude,codex};
      return helpCache;
    } finally { helpLoading = undefined; }
  })();
  return helpLoading;
}
// Printable, and nothing that ends or escapes a single-quoted word.
const shellSafe = (value: string): boolean => value.length > 0 &&
  [...value].every(c => c !== "'" && c !== '\\' && c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
/**
 * Pin a `buildAgentLaunch` command to the binary and PATH the probe verified.
 * The pane runs it through `$SHELL -lc`, whose profile (and macOS path_helper)
 * rewrites PATH after the pane env is applied; `/usr/bin/env PATH=… <bin>` sets
 * PATH for the agent itself last, so the binary and its `#!/usr/bin/env node`
 * interpreter are the ones the probe saw. Returns the command unchanged when
 * there is nothing verified to pin (Windows, or an unexpected character).
 */
export async function pinnedAgentLaunch(command: string): Promise<string> {
  const agent = command.split(' ')[0];
  if (process.platform === 'win32' || (agent !== 'claude' && agent !== 'codex')) return command;
  const cli = await installedHelp();
  const bin = cli[agent].bin;
  if (!bin || !shellSafe(bin) || !shellSafe(cli.path)) return command;
  return `/usr/bin/env PATH='${cli.path}' '${bin}'${command.slice(agent.length)}`;
}
export async function installedAgentLaunchOptions(env: NodeJS.ProcessEnv = process.env): Promise<AgentLaunchOptions[]> {
  const cli = await installedHelp();
  const claude = claudeOptionsFromHelp(cli.claude.help);
  const options = claude ? [claude] : [];
  if (cli.codex.help.includes('Codex CLI') && cli.codex.help.includes('--model') && cli.codex.help.includes('--config')) options.push(await codexOptions(env));
  return options;
}

/** Fixed launcher and advertised single-token flags; no prompt or arbitrary command. */
export function buildAgentLaunch(value: unknown, options: AgentLaunchOptions[]): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent launch');
  const choice = value as Record<string, unknown>;
  const option = options.find(option => option.agent === choice.agent);
  if (!option) throw new Error('Agent CLI is unavailable');
  const args: string[] = [option.agent];
  if (choice.model !== undefined) {
    if (typeof choice.model !== 'string' || !TOKEN.test(choice.model) || !option.models.includes(choice.model)) throw new Error('Unsupported model alias');
    args.push('--model', choice.model);
  }
  if (choice.effort !== undefined) {
    const supported = typeof choice.model === 'string' && option.modelEfforts ? option.modelEfforts[choice.model] ?? [] : option.efforts;
    if (typeof choice.effort !== 'string' || !supported.includes(choice.effort) || !CODEX_EFFORTS.has(choice.effort)) throw new Error('Unsupported effort');
    if (option.agent === 'codex') args.push('-c', `model_reasoning_effort=${choice.effort}`);
    else args.push('--effort', choice.effort);
  }
  return args.join(' ');
}

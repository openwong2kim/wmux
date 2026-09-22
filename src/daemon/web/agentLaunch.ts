import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentLaunchChoice { agent: 'claude' | 'codex'; model?: string; effort?: string }
export interface AgentLaunchOptions { agent: 'claude' | 'codex'; models: string[]; efforts: string[]; modelEfforts?: Record<string,string[]>; catalogState?: 'cached' | 'unavailable' }
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
let helpCache: {at:number;claude:string;codex:string} | undefined;
let helpLoading: Promise<{claude:string;codex:string}> | undefined;
function help(command: string): Promise<string> {
  return new Promise(resolve => execFile(command,['--help'],{timeout:3000,maxBuffer:128*1024,windowsHide:true},
    (error,stdout) => resolve(error ? '' : stdout)));
}
async function installedHelp(): Promise<{claude:string;codex:string}> {
  if (helpCache && Date.now() - helpCache.at < 300000) return helpCache;
  if (helpLoading) return helpLoading;
  helpLoading = Promise.all([help('claude'),help('codex')]).then(([claude,codex]) => {
    helpCache = {at:Date.now(),claude,codex};
    helpLoading = undefined;
    return helpCache;
  });
  return helpLoading;
}
export async function installedAgentLaunchOptions(env: NodeJS.ProcessEnv = process.env): Promise<AgentLaunchOptions[]> {
  const cli = await installedHelp();
  const claude = claudeOptionsFromHelp(cli.claude);
  const options = claude ? [claude] : [];
  if (cli.codex.includes('Codex CLI') && cli.codex.includes('--model') && cli.codex.includes('--config')) options.push(await codexOptions(env));
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

import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChatSkill, ChatSkillCatalog } from '../../shared/transcript/chatSkills';
import { connectCodexSettings } from '../web/codexSettingsTransport';

const LIMIT = 300;
const safeName = (name: unknown): name is string => typeof name === 'string' && /^[\p{L}\p{N}_:.+-]{1,120}$/u.test(name);
const clean = (text: unknown) => typeof text === 'string' ? Array.from(text).map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 240) : '';

async function prefix(file: string, bytes = 8192): Promise<string> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await fd.stat()).isFile()) throw new Error('Not a file');
    const buffer = Buffer.alloc(bytes);
    const result = await fd.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally { await fd.close(); }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function json(file: string): Promise<Record<string, unknown>> {
  try { return record(JSON.parse(await prefix(file, 256 * 1024))); } catch { return {}; }
}
/** Bounded frontmatter metadata, never the instruction body. */
export function skillMetadata(raw: string): Record<string, string> {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) return {};
  const result: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    result[match[1]] = value.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return result;
}

export async function claudeSkills(cwd: string, config = path.join(os.homedir(), '.claude')): Promise<ChatSkillCatalog> {
  const skills: ChatSkill[] = [];
  const seen = new Set<string>();
  let partial = true, visited = 0; // Session-only settings and enterprise policy are not observable here.
  async function add(file: string, fallback: string, source: string, namespace = '') {
    if (skills.length >= LIMIT) { partial = true; return; }
    try {
      const meta = skillMetadata(await prefix(file));
      if (meta['user-invocable'] === 'false') return;
      const name = namespace + (meta.name || fallback);
      if (!safeName(name) || seen.has(name)) return;
      seen.add(name);
      skills.push({ name, description: clean(meta.description), invocation: `/${name}`, source });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true; }
  }
  async function scan(root: string, source: string, namespace = '') {
    async function walk(dir: string, commands: boolean, depth: number) {
      if (depth > 4 || visited >= 1200) { partial = true; return; }
      try {
        const entries = await opendir(dir);
        for await (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'synced') continue;
          if (++visited > 1200 || skills.length >= LIMIT) { partial = true; break; }
          const file = path.join(dir, entry.name);
          if (commands) {
            if (entry.isDirectory()) await walk(file, true, depth + 1);
            else if (entry.name.endsWith('.md')) await add(file, entry.name.slice(0, -3), source, namespace);
          } else if (entry.isDirectory() || entry.isSymbolicLink()) await add(path.join(file, 'SKILL.md'), entry.name, source, namespace);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') partial = true; }
    }
    await walk(path.join(root, 'skills'), false, 0);
    await walk(path.join(root, 'commands'), true, 0);
  }
  const roots: string[] = [];
  let current = path.resolve(cwd);
  for (let i = 0; i < 24 && current !== os.homedir(); i++) {
    roots.push(path.join(current, '.claude'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await scan(config, 'user');
  for (const root of roots) await scan(root, 'project');
  const settings = await json(path.join(config, 'settings.json'));
  const enabled = { ...record(settings.enabledPlugins) };
  const overrides = { ...record(settings.skillOverrides) };
  for (const root of [...roots].reverse()) {
    Object.assign(overrides, (await json(path.join(root, 'settings.json'))).skillOverrides,
      (await json(path.join(root, 'settings.local.json'))).skillOverrides);
    Object.assign(enabled, (await json(path.join(root, 'settings.json'))).enabledPlugins,
      (await json(path.join(root, 'settings.local.json'))).enabledPlugins);
  }
  const registry = await json(path.join(config, 'plugins', 'installed_plugins.json'));
  for (const [id, installs] of Object.entries(record(registry.plugins)).slice(0, 200)) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const applicable = installs.filter(item => item && typeof item.installPath === 'string' &&
      (item.scope === 'user' || typeof item.projectPath === 'string' &&
        (cwd === item.projectPath || cwd.startsWith(item.projectPath + path.sep))));
    const install = applicable.find(item => item.scope === 'local') ?? applicable.find(item => item.scope === 'project') ?? applicable[0];
    if (!install) continue;
    const base = path.resolve(config, 'plugins', 'cache') + path.sep;
    if (!path.resolve(install.installPath).startsWith(base)) { partial = true; continue; }
    const manifest = await json(path.join(install.installPath, '.claude-plugin', 'plugin.json'));
    const namespace = manifest.name ?? id.split('@')[0];
    if (!safeName(namespace)) { partial = true; continue; }
    if (manifest.skills || manifest.commands) partial = true; // Custom plugin paths are not guessed.
    await scan(install.installPath, 'plugin', `${namespace}:`);
  }
  // Disk discovery cannot see session-only --add-dir/--settings or enterprise policy.
  return { skills: skills.filter(skill => skill.source === 'plugin' || overrides[skill.name] !== 'off').sort((a, b) => a.name.localeCompare(b.name)), state: partial ? 'partial' : 'ready' };
}

export function codexSkills(result: unknown, cwd: string): ChatSkillCatalog {
  const data = (result as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { skills: [], state: 'unavailable' };
  const entry = data.find(item => item?.cwd === cwd);
  if (!entry || !Array.isArray(entry.skills)) return { skills: [], state: 'unavailable' };
  const seen = new Set<string>();
  const skills: ChatSkill[] = [];
  for (const item of entry.skills) {
    if (item?.enabled !== true || !safeName(item.name) || seen.has(item.name)) continue;
    seen.add(item.name);
    skills.push({ name: item.name, description: clean(item.interface?.shortDescription ?? item.shortDescription ?? item.description),
      invocation: `$${item.name}`, source: item.pluginId ? 'plugin' : ['user', 'system'].includes(item.scope) ? item.scope : 'project' });
    if (skills.length >= LIMIT) break;
  }
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), state: entry.errors?.length || entry.skills.length > LIMIT ? 'partial' : 'ready' };
}

const cache = new Map<string, { until: number; promise: Promise<ChatSkillCatalog> }>();
export function loadChatSkills(agent: string, cwd: string, env: Record<string, string | undefined> = {}): Promise<ChatSkillCatalog> {
  const key = JSON.stringify([agent, cwd, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]);
  const previous = cache.get(key);
  if (previous && previous.until > Date.now()) return previous.promise;
  const promise = (async (): Promise<ChatSkillCatalog> => {
    try {
      if (agent === 'claude') return await claudeSkills(cwd, env.CLAUDE_CONFIG_DIR);
      if (agent === 'codex') {
        const connection = await connectCodexSettings({ cwd, codeHome: env.CODEX_HOME });
        try { return codexSkills(await connection.skills(cwd), cwd); } finally { connection.close(); }
      }
    } catch { /* Account connection may not exist yet. Do not start an agent to populate a menu. */ }
    return { skills: [], state: 'unavailable' };
  })();
  const oldest = cache.keys().next().value;
  if (cache.size >= 64 && oldest !== undefined) cache.delete(oldest);
  cache.set(key, { until: Date.now() + 5000, promise });
  return promise;
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseTomlText } from 'smol-toml';
import { stripBom } from '../../../shared/stripBom';
import type { CliRunner, InventoryDeps } from './types';

export function normalizePath(p: string, baseDir?: string): string {
  let resolved: string;
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(p);
  if (baseDir && !path.isAbsolute(p) && !isWindowsAbsolute) {
    if (baseDir.includes('\\') || /^[a-zA-Z]:/.test(baseDir)) {
      resolved = path.win32.resolve(baseDir, p);
    } else {
      resolved = path.resolve(baseDir, p);
    }
  } else if (isWindowsAbsolute) {
    resolved = p;
  } else {
    resolved = path.resolve(p);
  }

  let normalized = resolved.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  normalized = path.posix.normalize(normalized);

  if (process.platform === 'win32' || /^[a-z]:\//i.test(normalized)) {
    normalized = normalized.toLowerCase();
  }

  if (normalized.length > 3 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export function parseSemver(output: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
  return m ? m[1] : null;
}

export async function queryCliVersion(
  cli: string,
  run?: CliRunner,
): Promise<string | null> {
  if (!run) return null;
  try {
    const out = await run(cli, ['--version']);
    return parseSemver(out);
  } catch {
    return null;
  }
}

export async function safeReadFile(
  filePath: string,
  deps: InventoryDeps,
  warnings: string[],
): Promise<string | null> {
  const readFn = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  try {
    return await readFn(filePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to read ${filePath}: ${msg}`);
    return null;
  }
}

export function safeParseJson<T = unknown>(
  filePath: string,
  content: string | null,
  warnings: string[],
): T | null {
  if (content === null) return null;
  try {
    return JSON.parse(stripBom(content)) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to parse JSON at ${filePath}: ${msg}`);
    return null;
  }
}

export function safeParseToml<T = unknown>(
  filePath: string,
  content: string | null,
  warnings: string[],
): T | null {
  if (content === null) return null;
  try {
    return parseTomlText(content) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to parse TOML at ${filePath}: ${msg}`);
    return null;
  }
}

export async function safeReaddir(
  dirPath: string,
  deps: InventoryDeps,
): Promise<string[]> {
  const readdirFn = deps.readdir ?? ((p: string) => fs.readdir(p));
  try {
    return await readdirFn(dirPath);
  } catch {
    return [];
  }
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];
  const lines = yaml.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let inDesc = false;

  for (const line of lines) {
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) {
      inDesc = false;
      name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      inDesc = true;
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (inDesc) {
      if (/^\s+/.test(line)) {
        description = (description ? description + ' ' : '') + line.trim().replace(/^['"]|['"]$/g, '');
      } else {
        inDesc = false;
      }
    }
  }
  return { name, description };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Item id of one Claude hook: its name plus a hash of the file it lives in and its fingerprint. Ids
 * built from the name and an order suffix moved to another hook when one was removed, which hid the
 * removed hook's saved definition and let a later disable overwrite it.
 */
export function hookItemId(name: string, originPath: string | null, fingerprint: string): string {
  const key = createHash('sha256')
    .update(`${originPath ? normalizePath(originPath) : ''}|${fingerprint}`)
    .digest('hex')
    .slice(0, 12);
  return `${['claude', 'hook', '', name].map(encodeURIComponent).join(':')}#${key}`;
}

/** Identity of one hook handler: its event, its matcher group (without `hooks`) and the handler itself. */
export function hookFingerprint(
  event: string,
  groupMeta: Record<string, unknown> | undefined,
  handler: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalJson({ event, groupMeta: groupMeta ?? null, handler }))
    .digest('hex')
    .slice(0, 16);
}

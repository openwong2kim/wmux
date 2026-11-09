import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseTomlText } from 'smol-toml';
import { stripBom } from '../../../../shared/stripBom';
import type { SurfaceFileEdit, SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import type { TomlEdit } from '../../safeWrite';
import type { ResolvedChange, WriterDeps } from '../types';

export interface PlannedEditsResult {
  tomlEdits: TomlEdit[];
  edits: SurfaceFileEdit[];
  applicableItemIds: string[];
}

export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Key Codex uses under `hooks.state` for one handler: `<file>:<snake_event>:<group>:<handler>`. */
export function codexHookStateKey(filePath: string, event: string, handlerIdx: number): string {
  return `${filePath}:${toSnakeCase(event)}:0:${handlerIdx}`;
}

export function formatTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  if (key.includes('\\') && !key.includes("'")) {
    return `'${key}'`;
  }
  return JSON.stringify(key);
}

export function formatTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\\') && !value.includes("'") && !value.includes('\n') && !value.includes('\r')) {
      return `'${value}'`;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(', ')}]`;
  }
  return JSON.stringify(value);
}

function normalizePath(p: string, baseDir?: string): string {
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

function findMatchingSkillPath(
  parsed: Record<string, unknown>,
  originPath: string,
  configDir: string,
): string {
  const skills = parsed.skills as Record<string, unknown> | undefined;
  const skillsConfig = (skills && typeof skills === 'object' && 'config' in skills)
    ? (skills as { config?: unknown }).config
    : parsed['skills.config'];

  if (Array.isArray(skillsConfig)) {
    const normOrigin = normalizePath(originPath, configDir);
    for (const entry of skillsConfig) {
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        if (normalizePath(entry.path, configDir) === normOrigin) {
          return entry.path;
        }
      }
    }
  }
  return originPath;
}

export function normalizeDriveAndSeparators(p: string): string {
  let norm = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(norm)) {
    norm = norm[0].toLowerCase() + norm.slice(1);
  }
  return norm;
}

function findHookStateKey(
  parsed: Record<string, unknown>,
  item: SurfaceItem,
  deps: WriterDeps,
): string {
  const filePath = item.originPath ?? path.join(deps.homeDir, '.codex', 'hooks.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Hooks file not found: ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`Failed to read hooks file at ${filePath}`);
  }

  let hooksJson: unknown;
  try {
    hooksJson = JSON.parse(stripBom(content));
  } catch {
    throw new Error(`Failed to parse hooks file at ${filePath}`);
  }

  if (!hooksJson || typeof hooksJson !== 'object' || Array.isArray(hooksJson)) {
    throw new Error(`Invalid hooks JSON structure at ${filePath}`);
  }

  const rawJson = hooksJson as Record<string, unknown>;
  const entries = (rawJson.hooks && typeof rawJson.hooks === 'object' && !Array.isArray(rawJson.hooks))
    ? (rawJson.hooks as Record<string, unknown>)
    : rawJson;

  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(`No hook entries found in ${filePath}`);
  }

  const keys = Object.keys(entries);
  const handlerIdx = keys.indexOf(item.name);
  if (handlerIdx === -1) {
    throw new Error(`Hook '${item.name}' not found in ${filePath}`);
  }

  const rawConf = entries[item.name];
  if (!rawConf || typeof rawConf !== 'object' || Array.isArray(rawConf)) {
    throw new Error(`Invalid hook config for '${item.name}' in ${filePath}`);
  }

  const conf = rawConf as Record<string, unknown>;
  const rawEvent = typeof conf.event === 'string'
    ? conf.event
    : typeof conf.type === 'string'
      ? conf.type
      : item.hookEvent;

  if (!rawEvent) {
    throw new Error(`Cannot determine hook event for '${item.name}' in ${filePath}`);
  }

  const exactKey = codexHookStateKey(filePath, rawEvent, handlerIdx);

  const hooksTable = parsed.hooks as Record<string, unknown> | undefined;
  const hooksState = (hooksTable && typeof hooksTable === 'object' && 'state' in hooksTable)
    ? (hooksTable as { state?: unknown }).state
    : parsed['hooks.state'];

  const normExactKey = normalizeDriveAndSeparators(exactKey);

  if (hooksState && typeof hooksState === 'object' && !Array.isArray(hooksState)) {
    for (const stateKey of Object.keys(hooksState)) {
      if (normalizeDriveAndSeparators(stateKey) === normExactKey) {
        return stateKey;
      }
    }
  }

  return exactKey;
}

export function planEdits(
  text: string,
  configPath: string,
  changes: ResolvedChange[],
  deps: WriterDeps,
): PlannedEditsResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = text.trim() ? (parseTomlText(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  const tomlEdits: TomlEdit[] = [];
  const edits: SurfaceFileEdit[] = [];
  const applicableItemIds: string[] = [];

  const toolChangesByParent = new Map<string, ResolvedChange[]>();

  for (const change of changes) {
    const { item, enabled } = change;

    switch (item.kind) {
      case 'mcp-server': {
        applicableItemIds.push(item.id);
        if (!enabled) {
          tomlEdits.push({
            table: ['mcp_servers', item.name],
            key: 'enabled',
            op: 'set',
            value: false,
          });
          edits.push({
            path: configPath,
            summary: `set mcp_servers.${formatTomlKey(item.name)}.enabled = false`,
          });
        } else {
          tomlEdits.push({
            table: ['mcp_servers', item.name],
            key: 'enabled',
            op: 'delete',
          });
          edits.push({
            path: configPath,
            summary: `delete mcp_servers.${formatTomlKey(item.name)}.enabled`,
          });
        }
        break;
      }

      case 'mcp-tool': {
        if (!item.parent) {
          throw new Error(`MCP tool '${item.name}' is missing a parent server.`);
        }
        if (!toolChangesByParent.has(item.parent)) {
          toolChangesByParent.set(item.parent, []);
        }
        toolChangesByParent.get(item.parent)!.push(change);
        break;
      }

      case 'plugin': {
        applicableItemIds.push(item.id);
        tomlEdits.push({
          table: ['plugins', item.name],
          key: 'enabled',
          op: 'set',
          value: enabled,
        });
        edits.push({
          path: configPath,
          summary: `set plugins.${formatTomlKey(item.name)}.enabled = ${enabled}`,
        });
        break;
      }

      case 'skill': {
        if (!item.originPath) {
          throw new Error(`Skill '${item.name}' is missing an originPath.`);
        }
        applicableItemIds.push(item.id);
        const configDir = path.dirname(configPath);
        const matchPath = findMatchingSkillPath(parsed, item.originPath, configDir);

        tomlEdits.push({
          arrayTable: ['skills', 'config'],
          match: { path: matchPath },
          key: 'enabled',
          op: 'set',
          value: enabled,
        });
        edits.push({
          path: configPath,
          summary: `set skills.config path = ${formatTomlValue(matchPath)} enabled = ${enabled}`,
        });
        break;
      }

      case 'hook': {
        if (
          item.wmuxRequired ||
          item.source === 'wmux' ||
          item.name.startsWith('wmux-') ||
          item.name === 'codex-notify'
        ) {
          throw new Error('Hooks owned by wmux are handled by the dispatcher.');
        }

        applicableItemIds.push(item.id);
        const stateKey = findHookStateKey(parsed, item, deps);

        tomlEdits.push({
          table: ['hooks', 'state', stateKey],
          key: 'enabled',
          op: 'set',
          value: enabled,
        });
        edits.push({
          path: configPath,
          summary: `set hooks.state.${formatTomlKey(stateKey)}.enabled = ${enabled}`,
        });
        break;
      }

      case 'builtin-tool': {
        if (item.name === 'web_search') {
          applicableItemIds.push(item.id);
          const wsValue = enabled ? 'live' : 'disabled';
          tomlEdits.push({
            table: ['features'],
            key: 'web_search',
            op: 'set',
            value: wsValue,
          });
          edits.push({
            path: configPath,
            summary: `set features.web_search = "${wsValue}"`,
          });
        } else if (
          ['shell_tool', 'multi_agent', 'memories'].includes(item.name) ||
          (parsed.features &&
            typeof parsed.features === 'object' &&
            item.name in (parsed.features as Record<string, unknown>))
        ) {
          applicableItemIds.push(item.id);
          tomlEdits.push({
            table: ['features'],
            key: item.name,
            op: 'set',
            value: enabled,
          });
          edits.push({
            path: configPath,
            summary: `set features.${item.name} = ${enabled}`,
          });
        } else {
          throw new Error(`Unsupported builtin tool: ${item.name}`);
        }
        break;
      }

      default: {
        throw new Error(`Unsupported item kind or setting: ${item.kind} (${item.name})`);
      }
    }
  }

  // Process grouped MCP tool changes
  for (const [parent, parentChanges] of toolChangesByParent.entries()) {
    const mcpServers = parsed.mcp_servers as Record<string, unknown> | undefined;
    const serverConf = (mcpServers && typeof mcpServers === 'object')
      ? (mcpServers[parent] as Record<string, unknown> | undefined)
      : undefined;

    const initialDisabled: string[] = Array.isArray(serverConf?.disabled_tools)
      ? (serverConf.disabled_tools as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const hasDisabledKey = Array.isArray(serverConf?.disabled_tools);

    const initialEnabled: string[] | null = Array.isArray(serverConf?.enabled_tools)
      ? (serverConf.enabled_tools as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;

    let curDisabled = [...initialDisabled];
    let curEnabled = initialEnabled !== null ? [...initialEnabled] : null;

    for (const change of parentChanges) {
      applicableItemIds.push(change.item.id);
      const toolName = change.item.name;

      if (!change.enabled) {
        if (!curDisabled.includes(toolName)) {
          curDisabled.push(toolName);
        }
        if (curEnabled !== null) {
          curEnabled = curEnabled.filter((t) => t !== toolName);
        }
      } else {
        curDisabled = curDisabled.filter((t) => t !== toolName);
        if (curEnabled !== null && !curEnabled.includes(toolName)) {
          curEnabled.push(toolName);
        }
      }
    }

    const disabledChanged =
      curDisabled.length !== initialDisabled.length ||
      curDisabled.some((t, i) => t !== initialDisabled[i]) ||
      (!hasDisabledKey && curDisabled.length > 0);

    if (disabledChanged || (hasDisabledKey && curDisabled.length === 0)) {
      if (curDisabled.length === 0) {
        tomlEdits.push({
          table: ['mcp_servers', parent],
          key: 'disabled_tools',
          op: 'delete',
        });
        edits.push({
          path: configPath,
          summary: `delete mcp_servers.${formatTomlKey(parent)}.disabled_tools`,
        });
      } else {
        tomlEdits.push({
          table: ['mcp_servers', parent],
          key: 'disabled_tools',
          op: 'set',
          value: curDisabled,
        });
        edits.push({
          path: configPath,
          summary: `set mcp_servers.${formatTomlKey(parent)}.disabled_tools = [${curDisabled.map((t) => JSON.stringify(t)).join(', ')}]`,
        });
      }
    }

    if (curEnabled !== null && initialEnabled !== null) {
      const enabledChanged =
        curEnabled.length !== initialEnabled.length ||
        curEnabled.some((t, i) => t !== initialEnabled[i]);

      if (enabledChanged) {
        tomlEdits.push({
          table: ['mcp_servers', parent],
          key: 'enabled_tools',
          op: 'set',
          value: curEnabled,
        });
        edits.push({
          path: configPath,
          summary: `set mcp_servers.${formatTomlKey(parent)}.enabled_tools = [${curEnabled.map((t) => JSON.stringify(t)).join(', ')}]`,
        });
      }
    }
  }

  return { tomlEdits, edits, applicableItemIds };
}

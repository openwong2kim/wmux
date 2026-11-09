import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SurfaceFileEdit, SurfaceItem, SurfaceKind } from '../../../../shared/tokenUsage/surfaceTypes';
import { SurfacesStore } from '../../safeWrite';
import type { JsonEdit } from '../../safeWrite';
import type { ResolvedChange, WriterDeps } from '../types';
import { applyHookChangesToRoot } from './hookTarget';
import { deepEqual } from '../../safeWrite/deepEqual';
import { foldPathCase } from '../../safeWrite/pathCase';
import { isPathAllowed, resolveCanonicalPath } from './pathSecurity';
import { stripBom } from '../../../../shared/stripBom';

function pathsEqual(p1: string, p2: string): boolean {
  const norm1 = path.normalize(p1);
  const norm2 = path.normalize(p2);
  return foldPathCase(norm1) === foldPathCase(norm2);
}

export function isValidSettingsPath(targetPath: string | undefined | null, deps: WriterDeps): boolean {
  if (!targetPath) return false;
  const base = path.basename(targetPath);
  if (base !== 'settings.json' && base !== 'settings.local.json') {
    return false;
  }
  try {
    const canonicalTarget = resolveCanonicalPath(targetPath);
    const canonicalTargetDir = path.dirname(canonicalTarget);

    const canonicalHomeClaude = resolveCanonicalPath(path.join(deps.homeDir, '.claude'));
    if (pathsEqual(canonicalTargetDir, canonicalHomeClaude)) {
      return true;
    }

    if (deps.projectDir) {
      const canonicalProjClaude = resolveCanonicalPath(path.join(deps.projectDir, '.claude'));
      if (pathsEqual(canonicalTargetDir, canonicalProjClaude)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveSettingsPath(item: SurfaceItem, deps: WriterDeps): string {
  // The file that already holds this item's deny or override wins.
  if (item.settingsPath && isValidSettingsPath(item.settingsPath, deps)) {
    return path.resolve(item.settingsPath);
  }
  if (item.originPath) {
    if (!isPathAllowed(item.originPath, deps)) {
      return path.resolve(item.originPath);
    }
    if (isValidSettingsPath(item.originPath, deps)) {
      return path.resolve(item.originPath);
    }
  }
  // A project item is switched for this project only, never in the user-wide file.
  if (item.source === 'project' && deps.projectDir) {
    return path.join(deps.projectDir, '.claude', 'settings.local.json');
  }
  return path.join(deps.homeDir, '.claude', 'settings.json');
}

export function buildSettingsEdits(
  targetPath: string,
  deps: WriterDeps,
  changes: ResolvedChange[],
  isApply: boolean,
  store?: SurfacesStore,
  /** The apply snapshot's text, so the plan and the conflict check see the same content. */
  snapshotText?: string | null,
): { edits: JsonEdit[]; fileEdits: SurfaceFileEdit[]; affectedItemIds: string[] } {
  if (!isPathAllowed(targetPath, deps)) {
    return { edits: [], fileEdits: [], affectedItemIds: [] };
  }

  const origRoot = readSettingsRoot(targetPath, snapshotText);
  const root: Record<string, unknown> = JSON.parse(JSON.stringify(origRoot));
  const fileEdits: SurfaceFileEdit[] = [];
  const affectedItemIds: string[] = [];
  const hookChanges: ResolvedChange[] = [];

  for (const c of changes) {
    const rootBefore = JSON.stringify(root);
    const summary = ITEM_EDITS[c.item.kind]?.(root, c.item, c.enabled) ?? null;
    if (summary === null) continue;
    if (c.item.kind === 'hook') {
      hookChanges.push(c);
    } else if (JSON.stringify(root) === rootBefore) {
      // An item whose step changed nothing in this file is not applied (its deny or override lives
      // elsewhere, or was never set): report it as unapplied instead of claiming success.
      continue;
    }
    fileEdits.push({ path: targetPath, summary });
    affectedItemIds.push(c.item.id);
  }

  if (hookChanges.length > 0 && isApply && store) {
    applyHookChangesToRoot(root, hookChanges, targetPath, store);
  }

  return { edits: topLevelEdits(origRoot, root), fileEdits, affectedItemIds };
}

function readSettingsRoot(targetPath: string, snapshotText: string | null | undefined): Record<string, unknown> {
  const text =
    snapshotText !== undefined ? snapshotText : fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  if (text === null) return {};
  try {
    return JSON.parse(stripBom(text));
  } catch {
    return {};
  }
}

/** One JsonEdit per top-level key that differs: a set, or a delete when the key is gone. */
function topLevelEdits(origRoot: Record<string, unknown>, root: Record<string, unknown>): JsonEdit[] {
  const edits: JsonEdit[] = [];
  for (const k of new Set([...Object.keys(origRoot), ...Object.keys(root)])) {
    if (deepEqual(origRoot[k], root[k])) continue;
    edits.push(k in root ? { path: [k], op: 'set', value: root[k] } : { path: [k], op: 'delete' });
  }
  return edits;
}

/**
 * Applies one change to the settings root. Returns the summary shown for it, or null when this kind
 * leaves the item alone.
 */
type ItemEdit = (root: Record<string, unknown>, item: SurfaceItem, enabled: boolean) => string | null;

const ITEM_EDITS: Record<SurfaceKind, ItemEdit> = {
  'mcp-server': editDeniedServer,
  'mcp-tool': (root, item, enabled) => editPermissionDeny(root, `mcp__${item.parent}__${item.name}`, enabled),
  'builtin-tool': (root, item, enabled) => editPermissionDeny(root, item.name, enabled),
  plugin: (root, item, enabled) => {
    if (!root.enabledPlugins || typeof root.enabledPlugins !== 'object') {
      root.enabledPlugins = {};
    }
    (root.enabledPlugins as Record<string, unknown>)[item.name] = enabled;
    return `set enabledPlugins["${item.name}"] = ${enabled}`;
  },
  skill: editSkillOverride,
  'context-setting': (root, item, enabled) => {
    // Numbers and lists are listed read-only; writing 1/0 over them would lose the user's value.
    if (typeof root[item.name] !== 'boolean') return null;
    const value = item.name.startsWith('disable') ? !enabled : enabled;
    root[item.name] = value;
    return `set ${item.name} = ${value}`;
  },
  hook: (_root, item, enabled) => {
    // Managed hooks cannot be toggled. The others are removed or restored once every item is planned.
    if (item.source === 'managed') return null;
    const where = item.hookEvent ?? 'hooks';
    return enabled ? `restore hook "${item.name}" to ${where}` : `remove hook "${item.name}" from ${where}`;
  },
};

/** Non-project servers are disabled through deniedMcpServers; project servers live in ~/.claude.json. */
function editDeniedServer(root: Record<string, unknown>, item: SurfaceItem, enabled: boolean): string | null {
  const isThisServer = (d: unknown) =>
    !!d && typeof d === 'object' && (d as Record<string, unknown>).serverName === item.name;
  if (!enabled) {
    if (item.source === 'project') return null;
    const denied = Array.isArray(root.deniedMcpServers) ? [...(root.deniedMcpServers as unknown[])] : [];
    if (!denied.some(isThisServer)) {
      denied.push({ serverName: item.name });
    }
    root.deniedMcpServers = denied;
    return `add "${item.name}" to deniedMcpServers`;
  }
  if (!Array.isArray(root.deniedMcpServers) || !root.deniedMcpServers.some(isThisServer)) return null;
  const remaining = root.deniedMcpServers.filter((d) => !isThisServer(d));
  if (remaining.length === 0) {
    delete root.deniedMcpServers;
  } else {
    root.deniedMcpServers = remaining;
  }
  return `remove "${item.name}" from deniedMcpServers`;
}

function editPermissionDeny(root: Record<string, unknown>, entry: string, enabled: boolean): string {
  if (!enabled) {
    if (!root.permissions || typeof root.permissions !== 'object') {
      root.permissions = {};
    }
    const perms = root.permissions as Record<string, unknown>;
    const deny = Array.isArray(perms.deny) ? [...(perms.deny as string[])] : [];
    if (!deny.includes(entry)) {
      deny.push(entry);
    }
    perms.deny = deny;
    return `add "${entry}" to permissions.deny`;
  }
  const perms = root.permissions as Record<string, unknown> | undefined;
  if (perms && typeof perms === 'object' && Array.isArray(perms.deny)) {
    perms.deny = (perms.deny as string[]).filter((t) => t !== entry);
    if ((perms.deny as string[]).length === 0) {
      delete perms.deny;
    }
    if (Object.keys(perms).length === 0) {
      delete root.permissions;
    }
  }
  return `remove "${entry}" from permissions.deny`;
}

function editSkillOverride(root: Record<string, unknown>, item: SurfaceItem, enabled: boolean): string | null {
  // Plugin skills are not toggleable
  if (item.source === 'plugin') return null;
  if (!enabled) {
    if (!root.skillOverrides || typeof root.skillOverrides !== 'object') {
      root.skillOverrides = {};
    }
    (root.skillOverrides as Record<string, unknown>)[item.name] = 'off';
    return `set skillOverrides["${item.name}"] = "off"`;
  }
  if (root.skillOverrides && typeof root.skillOverrides === 'object') {
    delete (root.skillOverrides as Record<string, unknown>)[item.name];
    if (Object.keys(root.skillOverrides).length === 0) {
      delete root.skillOverrides;
    }
  }
  return `delete skillOverrides["${item.name}"]`;
}

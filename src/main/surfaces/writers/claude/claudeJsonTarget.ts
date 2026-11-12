import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SurfaceFileEdit } from '../../../../shared/tokenUsage/surfaceTypes';
import { normalizePath } from '../../inventory/helpers';
import type { JsonEdit } from '../../safeWrite';
import type { ResolvedChange, WriterDeps } from '../types';
import { stripBom } from '../../../../shared/stripBom';

export function getClaudeJsonPath(deps: WriterDeps): string {
  return path.join(deps.homeDir, '.claude.json');
}

export function findProjectKeyInClaudeJson(
  claudeJson: Record<string, unknown>,
  projectDir: string,
): string {
  if (claudeJson.projects && typeof claudeJson.projects === 'object') {
    const normProj = normalizePath(projectDir);
    for (const k of Object.keys(claudeJson.projects as Record<string, unknown>)) {
      if (normalizePath(k) === normProj) {
        return k;
      }
    }
  }
  return projectDir;
}

export function buildClaudeJsonEdits(
  deps: WriterDeps,
  changes: ResolvedChange[],
  /** The apply snapshot's text, so the plan and the conflict check see the same content. */
  snapshotText?: string | null,
): { edits: JsonEdit[]; fileEdits: SurfaceFileEdit[]; affectedItemIds: string[] } {
  const claudeJsonPath = getClaudeJsonPath(deps);
  let parsed: Record<string, unknown> = {};
  const text =
    snapshotText !== undefined
      ? snapshotText
      : fs.existsSync(claudeJsonPath)
        ? fs.readFileSync(claudeJsonPath, 'utf8')
        : null;
  if (text !== null) {
    try {
      parsed = JSON.parse(stripBom(text));
    } catch {
      parsed = {};
    }
  }

  // MCP server changes relevant to ~/.claude.json:
  // 1) All project MCP server disables/enables
  // 2) Any MCP server enable (clean both places if present)
  const relevantChanges = changes.filter((c) => {
    if (c.item.kind !== 'mcp-server') return false;
    if (c.item.source === 'project') return true;
    // When enabling any MCP server, check if it exists in ~/.claude.json
    if (c.enabled && deps.projectDir) return true;
    return false;
  });

  if (relevantChanges.length === 0) {
    return { edits: [], fileEdits: [], affectedItemIds: [] };
  }

  if (!deps.projectDir) {
    // If any project MCP server needs toggling but projectDir is unknown, refuse with a plain Error
    const needsProject = relevantChanges.some((c) => c.item.source === 'project');
    if (needsProject) {
      throw new Error('Project directory is required to toggle project MCP server');
    }
    return { edits: [], fileEdits: [], affectedItemIds: [] };
  }

  const projKey = findProjectKeyInClaudeJson(parsed, deps.projectDir);
  const projObj = (parsed.projects as Record<string, unknown> | undefined)?.[projKey] as
    | Record<string, unknown>
    | undefined;
  const existingDisabled = Array.isArray(projObj?.disabledMcpServers)
    ? [...(projObj!.disabledMcpServers as string[])]
    : [];

  let currentDisabled = [...existingDisabled];
  const fileEdits: SurfaceFileEdit[] = [];
  const affectedItemIds: string[] = [];

  for (const c of relevantChanges) {
    if (!c.enabled) {
      // Disabling project MCP server
      if (!currentDisabled.includes(c.item.name)) {
        currentDisabled.push(c.item.name);
      }
      fileEdits.push({
        path: claudeJsonPath,
        summary: `add "${c.item.name}" to projects["${projKey}"].disabledMcpServers`,
      });
      affectedItemIds.push(c.item.id);
    } else {
      // Enabling MCP server
      const wasInList = currentDisabled.includes(c.item.name);
      if (wasInList) {
        currentDisabled = currentDisabled.filter((s) => s !== c.item.name);
        fileEdits.push({
          path: claudeJsonPath,
          summary: `remove "${c.item.name}" from projects["${projKey}"].disabledMcpServers`,
        });
        if (!affectedItemIds.includes(c.item.id)) {
          affectedItemIds.push(c.item.id);
        }
      } else if (c.item.source === 'project') {
        // Project server enabled even if wasn't in list
        if (!affectedItemIds.includes(c.item.id)) {
          affectedItemIds.push(c.item.id);
        }
      }
    }
  }

  const edits: JsonEdit[] = [];
  const hasChanged =
    currentDisabled.length !== existingDisabled.length ||
    currentDisabled.some((s, idx) => s !== existingDisabled[idx]);

  if (hasChanged || (existingDisabled.length > 0 && currentDisabled.length === 0)) {
    if (currentDisabled.length === 0) {
      edits.push({
        path: ['projects', projKey, 'disabledMcpServers'],
        op: 'delete',
      });
    } else {
      edits.push({
        path: ['projects', projKey, 'disabledMcpServers'],
        op: 'set',
        value: currentDisabled,
      });
    }
  }

  return { edits, fileEdits, affectedItemIds };
}

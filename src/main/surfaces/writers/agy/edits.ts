import * as fs from 'node:fs';
import type { JsonEdit } from '../../safeWrite';
import type { SurfaceFileEdit } from '../../../../shared/tokenUsage/surfaceTypes';
import { parseSkillFrontmatter } from '../../inventory/helpers';
import type { ResolvedChange } from '../types';
import { getPluginDirName, getSkillDirName } from './paths';
import { stripBom } from '../../../../shared/stripBom';

export interface PlannedFileEdits {
  filePath: string;
  jsonEdits: JsonEdit[];
  previewEdits: SurfaceFileEdit[];
  itemIds: string[];
}

/**
 * Plans the JSON edits for one file. Pass the snapshot's text so the plan and the conflict check in
 * applyConfigEdit see the same content; without it the file is read here (preview only).
 */
export function planEditsForFile(
  filePath: string,
  changes: ResolvedChange[],
  snapshotText?: string | null,
): PlannedFileEdits {
  let parsed: any = null;
  try {
    const text =
      snapshotText !== undefined ? snapshotText : fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (text !== null) parsed = JSON.parse(stripBom(text));
  } catch {
    parsed = null;
  }

  const jsonEdits: JsonEdit[] = [];
  const previewEdits: SurfaceFileEdit[] = [];
  const itemIds: string[] = [];

  const disabledToolsByServer = new Map<string, unknown[]>();
  let skillExclude: unknown[] | null = null;

  for (const { item, enabled } of changes) {
    itemIds.push(item.id);

    if (item.kind === 'mcp-server') {
      if (!enabled) {
        jsonEdits.push({ op: 'set', path: ['mcpServers', item.name, 'disabled'], value: true });
        previewEdits.push({ path: filePath, summary: `set mcpServers."${item.name}".disabled = true` });
      } else {
        jsonEdits.push({ op: 'delete', path: ['mcpServers', item.name, 'disabled'] });
        previewEdits.push({ path: filePath, summary: `delete mcpServers."${item.name}".disabled` });
      }
    } else if (item.kind === 'mcp-tool') {
      const server = item.parent ?? '';
      if (!disabledToolsByServer.has(server)) {
        const raw = parsed?.mcpServers?.[server]?.disabledTools;
        const currentList: unknown[] = Array.isArray(raw) ? [...raw] : [];
        disabledToolsByServer.set(server, currentList);
      }
      const list = disabledToolsByServer.get(server)!;

      if (!enabled) {
        if (!list.includes(item.name)) {
          list.push(item.name);
        }
        jsonEdits.push({ op: 'set', path: ['mcpServers', server, 'disabledTools'], value: [...list] });
        previewEdits.push({ path: filePath, summary: `add "${item.name}" to mcpServers."${server}".disabledTools` });
      } else {
        const filtered = list.filter((t) => t !== item.name);
        disabledToolsByServer.set(server, filtered);
        if (filtered.length === 0) {
          jsonEdits.push({ op: 'delete', path: ['mcpServers', server, 'disabledTools'] });
        } else {
          jsonEdits.push({ op: 'set', path: ['mcpServers', server, 'disabledTools'], value: [...filtered] });
        }
        previewEdits.push({ path: filePath, summary: `remove "${item.name}" from mcpServers."${server}".disabledTools` });
      }
    } else if (item.kind === 'plugin') {
      const dirName = getPluginDirName(item);
      jsonEdits.push({ op: 'set', path: ['plugins', dirName, 'enabled'], value: enabled });
      previewEdits.push({ path: filePath, summary: `set plugins."${dirName}".enabled = ${enabled}` });
    } else if (item.kind === 'skill') {
      const skillDirName = getSkillDirName(item);
      if (skillExclude === null) {
        const raw = parsed?.exclude;
        skillExclude = Array.isArray(raw) ? [...raw] : [];
      }

      if (!enabled) {
        if (!skillExclude.includes(skillDirName)) {
          skillExclude.push(skillDirName);
        }
        jsonEdits.push({ op: 'set', path: ['exclude'], value: [...skillExclude] });
        previewEdits.push({ path: filePath, summary: `add "${skillDirName}" to exclude` });
      } else {
        const spellings = new Set<string>([skillDirName, item.name]);
        if (item.originPath) {
          try {
            if (fs.existsSync(item.originPath)) {
              const content = fs.readFileSync(item.originPath, 'utf8');
              const fm = parseSkillFrontmatter(content);
              if (fm.name) {
                spellings.add(fm.name);
              }
            }
          } catch {
            // ignore
          }
        }
        const matching = skillExclude.filter((x): x is string => typeof x === 'string' && spellings.has(x));
        skillExclude = skillExclude.filter((x) => typeof x !== 'string' || !spellings.has(x));
        if (skillExclude.length === 0) {
          jsonEdits.push({ op: 'delete', path: ['exclude'] });
        } else {
          jsonEdits.push({ op: 'set', path: ['exclude'], value: [...skillExclude] });
        }
        const uniqueMatching = Array.from(new Set(matching));
        const removedSummary = uniqueMatching.length > 0 ? uniqueMatching.join('", "') : skillDirName;
        previewEdits.push({ path: filePath, summary: `remove "${removedSummary}" from exclude` });
      }
    } else if (item.kind === 'hook') {
      const isNestedInHooks =
        parsed?.hooks &&
        typeof parsed.hooks === 'object' &&
        !Array.isArray(parsed.hooks);

      const keyPath = isNestedInHooks ? ['hooks', item.name, 'enabled'] : [item.name, 'enabled'];
      const summaryPrefix = isNestedInHooks ? `hooks.${item.name}` : item.name;

      if (!enabled) {
        jsonEdits.push({ op: 'set', path: keyPath, value: false });
        previewEdits.push({ path: filePath, summary: `set ${summaryPrefix}.enabled = false` });
      } else {
        jsonEdits.push({ op: 'delete', path: keyPath });
        previewEdits.push({ path: filePath, summary: `delete ${summaryPrefix}.enabled` });
      }
    } else {
      throw new Error(`Unsupported item kind: ${item.kind}`);
    }
  }

  return { filePath, jsonEdits, previewEdits, itemIds };
}

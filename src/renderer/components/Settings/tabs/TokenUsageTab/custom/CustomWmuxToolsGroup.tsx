import { useCallback, useMemo, useState } from 'react';
import { CORE_TOOL_SURFACE } from '../../../../../../shared/coreSurface';
import { ROLE_TOOL_SURFACES } from '../../../../../../shared/roleSurfaces';
import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Button from '../../../../ui/Button';
import Switch from '../../../../ui/Switch';

export interface CustomWmuxToolsGroupProps {
  tools: SurfaceItem[];
  allTools?: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  onBatchToggle?: (updates: Array<{ itemId: string; next: boolean }>) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomWmuxToolsGroup({
  tools,
  allTools,
  onToggle,
  onBatchToggle,
  stagedChanges,
  rejectedFlags,
}: CustomWmuxToolsGroupProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const fullToolList = allTools ?? tools;

  const enabledCount = useMemo(() => {
    return fullToolList.filter((t) => {
      const isStaged = stagedChanges?.has(t.id) ?? false;
      return isStaged ? stagedChanges!.get(t.id)! : t.enabled !== false;
    }).length;
  }, [fullToolList, stagedChanges]);

  const totalCount = fullToolList.length;

  const stagedToolsCount = useMemo(() => {
    return fullToolList.filter((t) => stagedChanges?.has(t.id)).length;
  }, [fullToolList, stagedChanges]);

  const applyPreset = useCallback(
    (preset: 'core' | 'planner' | 'reviewer' | 'none' | 'all-core' | 'all') => {
      if (!onBatchToggle) return;
      const targetTools = allTools ?? tools;
      const updates: Array<{ itemId: string; next: boolean }> = [];

      // Note: presets target only the wmux core tools shown in this group (CORE_TOOL_SURFACE).
      // browser_* and company_* tools are not included here.
      let isTargetEnabled: (name: string) => boolean;
      if (preset === 'core') {
        const coreSet = new Set(CORE_TOOL_SURFACE);
        isTargetEnabled = (name) => coreSet.has(name);
      } else if (preset === 'planner') {
        const plannerSet = new Set(ROLE_TOOL_SURFACES.Planner);
        isTargetEnabled = (name) => plannerSet.has(name);
      } else if (preset === 'reviewer') {
        const reviewerSet = new Set(ROLE_TOOL_SURFACES.Reviewer);
        isTargetEnabled = (name) => reviewerSet.has(name);
      } else if (preset === 'none') {
        isTargetEnabled = () => false;
      } else {
        // 'all-core' (and legacy 'all'): enables all core tools in this group
        isTargetEnabled = () => true;
      }

      for (const item of targetTools) {
        updates.push({
          itemId: item.id,
          next: isTargetEnabled(item.name),
        });
      }

      onBatchToggle(updates);
    },
    [allTools, onBatchToggle, tools],
  );

  if (fullToolList.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-2 my-4"
      data-testid="token-custom-wmux-group"
    >
      <div className="rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 text-[13px] border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            className="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0 text-left focus:outline-none"
            data-testid="token-custom-wmux-collapse-btn"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              className={`transition-transform duration-150 text-[var(--text-sub)] ${collapsed ? '-rotate-90' : 'rotate-0'}`}
              aria-hidden="true"
            >
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="font-medium text-[var(--text-main)]">{t('settings.tokenUsage.wmuxCoreTools')}</span>
            <span
              className="text-[11px] text-[var(--text-sub)]"
              data-testid="token-custom-wmux-count"
            >
              {t('settings.tokenUsage.enabledOfTotal', { enabled: enabledCount, total: totalCount })}
            </span>
            {stagedToolsCount > 0 && (
              <Badge tone="warning">
                {t('settings.tokenUsage.stagedCountBadge', { count: stagedToolsCount })}
              </Badge>
            )}
          </button>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyPreset('core')}
              data-testid="wmux-preset-core"
            >
              {t('settings.tokenUsage.presetCore')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyPreset('planner')}
              data-testid="wmux-preset-planner"
            >
              {t('settings.tokenUsage.presetPlanner')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyPreset('reviewer')}
              data-testid="wmux-preset-reviewer"
            >
              {t('settings.tokenUsage.presetReviewer')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyPreset('none')}
              data-testid="wmux-preset-none"
            >
              {t('settings.tokenUsage.presetNone')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => applyPreset('all-core')}
              data-testid="wmux-preset-all-core"
            >
              {t('settings.tokenUsage.presetAllCore')}
            </Button>
          </div>
        </div>

        <div
          className="px-3 py-2 text-[12px] text-[var(--text-sub)] border-b border-[var(--border-hairline)] bg-[var(--bg-mantle)]"
          data-testid="token-custom-wmux-note"
        >
          {t('settings.tokenUsage.wmuxToolsScopeNote')}
        </div>

        {!collapsed && (
          <div
            className="pl-6 pr-3 pb-2 pt-0 flex flex-col gap-1 divide-y divide-[var(--border-hairline)]"
            data-testid="wmux-tools-list"
          >
            {tools.length === 0 ? (
              <div className="text-[12px] text-[var(--text-sub)] py-3 text-center">
                {t('settings.tokenUsage.noWmuxToolsMatching')}
              </div>
            ) : (
              tools.map((tool) => {
                const isToolStaged = stagedChanges?.has(tool.id) ?? false;
                const toolEnabled = isToolStaged
                  ? stagedChanges!.get(tool.id)!
                  : tool.enabled !== false;
                const toolRejection = rejectedFlags?.get(tool.id);

                return (
                  <div
                    key={tool.id}
                    className="flex items-center justify-between text-[11px] py-1 border-t border-[var(--border-hairline)]"
                    data-testid={`mcp-tool-${tool.name}`}
                    data-staged={isToolStaged ? 'true' : undefined}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[var(--text-sub)]" aria-hidden="true">↳</span>
                      <span className="ui-code text-[var(--text-main)]">{tool.name}</span>
                      {isToolStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                      {toolRejection && (
                        <Badge tone="danger">{toolRejection}</Badge>
                      )}
                      {tool.readOnlyReason && (
                        <span className="text-[10px] text-[var(--text-sub)]">
                          ({tool.readOnlyReason})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {tool.toggleable && onToggle ? (
                        <Switch
                          checked={toolEnabled}
                          onCheckedChange={() => onToggle(tool.id)}
                          aria-label={t('settings.tokenUsage.toggleAria', { name: tool.name })}
                          data-testid={`toggle-mcp-tool-${tool.name}`}
                        />
                      ) : (
                        <Badge tone={toolEnabled ? 'success' : 'neutral'}>
                          {toolEnabled ? t('settings.tokenUsage.enabled') : t('settings.tokenUsage.disabled')}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

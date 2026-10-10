import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import PaletteItem, { type PaletteItemData, type PaletteCategory } from './PaletteItem';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from '../../utils/ptyCreateOptions';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { openUrlInBrowserPane } from '../../utils/browserPaneActions';
import { PRIVATE_BROWSER_PARTITION } from '../../../shared/privateBrowser';
import { isShadowWorkspaceId } from '../../../shared/pcRail';
import { hasAdoptableTaskDiff, openTaskDiff } from '../../utils/openTaskDiff';
import { tokenAttrs } from '../../themes';
import { usePlugins } from '../../plugins/usePlugins';
import { postPluginCommand } from '../../plugins/pluginFrameRegistry';
import { runProjectCommand } from '../../utils/projectCommands';
import { applyProjectLayoutFresh } from '../../utils/projectConfigProbe';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';
import { isChatV2Covering } from '../ChatV2/coverage';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { comboFromEvent, displayCombo, effectiveBindings, type ShortcutActionId } from '../../../shared/keymap';
import { shortcutPlatform, shortcutPressGuard } from '../../utils/shortcutBindings';
import {
  clearShortcut,
  customKeyConflict,
  describeShortcut,
  rebindProblemText,
  type KeyConflict,
} from '../../utils/shortcutRebind';
import KeyConflictConfirm from '../shared/KeyConflictConfirm';
import {
  openMultiTask,
  openWorktaskCleanup,
  renameActiveTab,
  showGitDiff,
  stashActivePane,
  toggleAgentToolbarPin,
  toggleActiveWorkspaceBookmark,
} from '../../utils/commandActions';

// ---------------------------------------------------------------------------
// SVG Icons (inline, no external dependency)
// ---------------------------------------------------------------------------

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.4" />
      <line x1="9.85" y1="9.85" x2="13" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconWorkspace() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconSurface() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="4" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="7" y1="10" x2="7" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconCommand() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="3,5 1,7 3,9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="11,5 13,7 11,9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8.5" y1="3" x2="5.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1" width="5" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1" y="8" width="5" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="5" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 2h8l2 2v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="4.5" y="1" width="5" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="3" y="7.5" width="8" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Fuzzy match helper
// Scores a string against a query. Returns null if no match, else a score
// (higher = better). Consecutive character matches are rewarded.
// ---------------------------------------------------------------------------

function fuzzyScore(str: string, query: string): number | null {
  if (query.length === 0) return 0;
  const s = str.toLowerCase();
  const q = query.toLowerCase();
  let si = 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -1;

  while (si < s.length && qi < q.length) {
    if (s[si] === q[qi]) {
      // Reward consecutive matches and start-of-word matches
      consecutive++;
      if (lastMatchIdx === si - 1) {
        score += 2 + consecutive;
      } else {
        consecutive = 0;
        score += 1;
      }
      // Bonus for matching at word start
      if (si === 0 || s[si - 1] === ' ' || s[si - 1] === '-' || s[si - 1] === '_') {
        score += 3;
      }
      lastMatchIdx = si;
      qi++;
    }
    si++;
  }

  return qi === q.length ? score : null;
}

// The keymap action behind each "Move Pane …" command.
const MOVE_PANE_ACTIONS = {
  left: 'movePaneLeft', right: 'movePaneRight', up: 'movePaneUp', down: 'movePaneDown',
} as const satisfies Record<string, ShortcutActionId>;

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

export default function CommandPalette() {
  const t = useT();
  const visible = useStore((s) => s.commandPaletteVisible);
  const setVisible = useStore((s) => s.setCommandPaletteVisible);
  // A1: 워크스페이스 "목록" 항목은 id/name만 필요 — 통트리 대신 {id,name} 투영을
  // 구독해 배경 ws churn에 재빌드/리렌더되지 않게 한다.
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // 리뷰 반영: 활성 ws surface 목록을 getState() 스냅샷으로만 읽으면 팔레트가
  // 열린 동안의 surface 추가/삭제/개명이 반영되지 않는다(조용한 stale).
  // visible-게이트 구독 — 닫혀 있으면 undefined 고정(구독 리렌더 0), 열려 있으면
  // 활성 ws 참조 변경(자기 트리 변경에만 바뀜)에 반응해 목록을 재빌드한다.
  const activeWorkspaceForItems = useStore((s) =>
    s.commandPaletteVisible ? s.workspaces.find((w) => w.id === s.activeWorkspaceId) : undefined,
  );
  const layoutTemplates = useStore((s) => s.layoutTemplates);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<HTMLSpanElement>(null);
  const { invoke: ipcInvoke } = useIpc();

  // Giving a command a shortcut without leaving the palette: Ctrl+Enter on
  // the active row (or a click on its key chip) records the next chord, with
  // the same rules Settings → Shortcuts applies (shortcutRebind).
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [recordNote, setRecordNote] = useState<string | null>(null);
  // #1885 — the recorded key also runs a custom keybinding: ask before the
  // built-in takes it. The ref lets the recorder's teardown leave focus in
  // the dialog instead of pulling it back to the search input underneath.
  const [keyConflict, setKeyConflict] = useState<
    { conflict: KeyConflict; action: ShortcutActionId; combo: string } | null
  >(null);
  const keyConflictOpenRef = useRef(false);
  const shortcutOverrides = useStore((s) => s.shortcutOverrides);
  const setShortcutOverride = useStore((s) => s.setShortcutOverride);
  const setKeyCaptureActive = useStore((s) => s.setKeyCaptureActive);
  const platform = shortcutPlatform();
  // The key each action runs on right now, as displayed. An action's first
  // binding is its primary (aliases follow it; an override replaces them all).
  const comboByAction = useMemo(() => {
    const map = new Map<ShortcutActionId, string>();
    for (const b of effectiveBindings(platform, shortcutOverrides)) {
      if (!map.has(b.action)) map.set(b.action, displayCombo(b.combo, platform));
    }
    return map;
  }, [platform, shortcutOverrides]);
  const startRecording = useCallback((action: ShortcutActionId) => {
    setRecordNote(null);
    setRecording(action);
  }, []);

  // -------------------------------------------------------------------------
  // Build item list
  // -------------------------------------------------------------------------

  const recentCommands = useStore((s) => s.recentCommands);
  const togglePalette = useStore((s) => s.toggleCommandPalette);
  // Plugin-contributed palette commands (B-1 ui.commands).
  const { plugins } = usePlugins();
  // Project config commands (X5 wmux.json) — active workspace only.
  const projectConfigs = useStore((s) => s.projectConfigs);
  // The fan-out task whose workspace is active, if any (Show Task Diff).
  // Visible-gated like activeWorkspaceForItems: no re-render while closed.
  const activeTask = useStore((s) =>
    s.commandPaletteVisible && s.activeWorkspaceId ? s.missionByPaneGroup[s.activeWorkspaceId] : undefined,
  );

  const buildItems = useCallback((): PaletteItemData[] => {
    const items: PaletteItemData[] = [];

    // Workspaces
    workspaces.forEach((ws) => {
      items.push({
        id: `ws-${ws.id}`,
        label: ws.name,
        category: 'workspace' as PaletteCategory,
        icon: <IconWorkspace />,
        action: () => {
          useStore.getState().setActiveWorkspace(ws.id);
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      });
    });

    // Surfaces — gather from active workspace leaf panes. 리뷰 반영: visible-게이트
    // 구독(activeWorkspaceForItems)을 쓰므로 팔레트가 열린 동안의 surface 변경도 반영된다.
    const activeWs = activeWorkspaceForItems;
    if (activeWs) {
      const collectSurfaces = (pane: import('../../../shared/types').Pane) => {
        if (pane.type === 'leaf') {
          pane.surfaces.forEach((surface) => {
            items.push({
              id: `surface-${surface.id}`,
              label: surface.title || 'Terminal',
              category: 'surface' as PaletteCategory,
              icon: <IconSurface />,
              action: () => {
                useStore.getState().setActiveSurface(pane.id, surface.id);
                showWorkspaces(useStore.getState());
                setVisible(false);
              },
            });
          });
        } else if (pane.type === 'branch') {
          pane.children.forEach(collectSurfaces);
        }
      };
      collectSurfaces(activeWs.rootPane);
    }

    // Built-in commands
    // `shortcut` names the keymap action the command runs, so its key shows
    // on the row and can be changed right here (Ctrl+Enter or the key chip).
    const commands: Array<{ label: string; action: () => void; shortcut?: ShortcutActionId }> = [
      {
        label: t('palette.cmd.toggleSidebar'),
        shortcut: 'toggleSidebar',
        action: () => { useStore.getState().toggleSidebar(); setVisible(false); },
      },
      {
        label: t('palette.cmd.splitRight'),
        shortcut: 'splitHorizontal',
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) state.splitPane(ws.activePaneId, 'horizontal');
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.splitDown'),
        shortcut: 'splitVertical',
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) state.splitPane(ws.activePaneId, 'vertical');
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      },
      {
        // #977 — stash the ACTIVE pane. There is no "unstash" command here on
        // purpose: unstashing needs a target, and the roster already lists the
        // stashed panes with a click that brings each one back. A palette entry
        // would have to invent a second picker for a list that already exists.
        label: t('palette.cmd.stashPane'),
        shortcut: 'stashPane',
        action: () => { stashActivePane(); setVisible(false); },
      },
      // #645 — move the active pane. Four entries rather than one "move pane"
      // with a follow-up prompt: the palette is a single-stage list, and
      // typing "move pane l" should just do it.
      ...(['left', 'right', 'up', 'down'] as const).map((dir) => ({
        label: t(`palette.cmd.movePane.${dir}` as Parameters<typeof t>[0]),
        shortcut: MOVE_PANE_ACTIONS[dir],
        action: () => { useStore.getState().moveActivePaneDirection(dir); showWorkspaces(useStore.getState()); setVisible(false); },
      })),
      {
        label: t('palette.cmd.newWorkspace'),
        shortcut: 'newWorkspace',
        action: () => { useStore.getState().addWorkspace(); showWorkspaces(useStore.getState()); setVisible(false); },
      },
      {
        label: t('palette.cmd.newSurface'),
        shortcut: 'newSurface',
        action: () => {
          const state = useStore.getState();
          // S-A Step 1 — gate event-driven pty.create until the startup
          // reconcile flips paneGate (same dda4c0c-race guard as Ctrl+T in
          // useKeyboard.ts; the palette outlives the paneGate placeholder).
          if (state.paneGate !== 'ready') {
            setVisible(false);
            return;
          }
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          // Another computer's (shadow) workspace never gets a local shell.
          if (ws && !isShadowWorkspaceId(ws.id)) {
            // Issue #175: new tabs honor profile.startupCwd > global startupDirectory.
            const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory });
            void ipcInvoke<{ id: string; cwd?: string }>(() =>
              window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ workspaceId: ws.id, cwd, spawnKind: 'user-shell' }, state.defaultShell), ws.profile))
            ).then((result) => {
              if (result.ok) {
                // #515: adopt the cwd main actually spawned in (was '' → later
                // splits seed from an empty cwd and fall back to home).
                useStore.getState().addSurface(ws.activePaneId, result.data.id, 'Terminal', result.data.cwd || '');
              }
            });
            showWorkspaces(state);
          }
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.showNotifications'),
        shortcut: 'toggleNotifications',
        action: () => { useStore.getState().setNotificationPanelVisible(true); setVisible(false); },
      },
      {
        label: t('palette.cmd.openFleetView'),
        shortcut: 'toggleFleetView',
        action: () => { useStore.getState().setFleetViewVisible(true); setVisible(false); },
      },
      {
        // The keyboard route to fan-out (see openMultiTask). This command does
        // not care whether the agent toolbar exists.
        label: t('palette.cmd.multiTask'),
        shortcut: 'multiTask',
        action: () => { openMultiTask(); setVisible(false); },
      },
      {
        label: t('palette.cmd.toggleToolbarPin'),
        shortcut: 'toggleToolbarPin',
        action: () => { toggleAgentToolbarPin(); setVisible(false); },
      },
      {
        label: t('palette.cmd.openWorktaskCleanup'),
        shortcut: 'openWorktaskCleanup',
        action: () => { openWorktaskCleanup(); setVisible(false); },
      },
      {
        label: t('palette.cmd.openBrowser'),
        shortcut: 'openBrowser',
        action: () => {
          // forceNew: the explicit "Open Browser" command always creates a
          // fresh split — reuse is for link/port clicks (browserPaneActions).
          openUrlInBrowserPane(undefined, { forceNew: true });
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.openPrivateBrowser'),
        shortcut: 'openPrivateBrowser',
        action: () => {
          openUrlInBrowserPane(undefined, { forceNew: true, partition: PRIVATE_BROWSER_PARTITION });
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.showGitDiff'),
        shortcut: 'showGitDiff',
        action: () => { showGitDiff(); setVisible(false); },
      },
      {
        // Close first: the rename field takes the keyboard, and the palette
        // must not still hold it when the field mounts.
        label: t('palette.cmd.renameTab'),
        shortcut: 'renameTab',
        action: () => { setVisible(false); renameActiveTab(); },
      },
      {
        // No default key: bookmarking is occasional, and the row menu has it.
        label: t('palette.cmd.toggleBookmark'),
        action: () => { toggleActiveWorkspaceBookmark(); setVisible(false); },
      },
    ];

    commands.forEach((cmd, i) => {
      items.push({
        id: `cmd-${i}`,
        label: cmd.label,
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: cmd.action,
        shortcut: cmd.shortcut,
      });
    });

    // #1461 — the task diff (hunk checkboxes and Adopt, plus PR and Close while
    // the task is open) for the fan-out task whose workspace is active. Show
    // Git Diff opens the read-only workspace diff, so without this the fan-out
    // toast and Fleet's Ready to review rows were the only ways back to a task
    // diff. Listed only in a task workspace that still has a worktree, under a
    // fixed id so it does not shift the `cmd-${i}` ids above.
    if (activeWorkspaceId && activeTask && hasAdoptableTaskDiff(activeTask)) {
      const task = activeTask;
      items.push({
        id: 'cmd-task-diff',
        label: t('palette.cmd.showTaskDiff'),
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: () => {
          openTaskDiff(task.id, activeWorkspaceId, task.title, task.owner.verifiedWorkspaceId);
          // The diff opens in a pane, which is on the Workspaces page.
          showWorkspaces(useStore.getState());
          setVisible(false);
        },
      });
    }

    // Company commands
    const state = useStore.getState();
    const hasCompany = !!state.company;

    if (COMPANY_MODE_ENABLED && !hasCompany) {
      const templates = [
        { name: 'Full-Stack Team', label: 'Company: Create Full-Stack Team' },
        { name: 'Startup MVP', label: 'Company: Create Startup MVP' },
        { name: 'Code Review Squad', label: 'Company: Create Code Review Squad' },
      ];
      templates.forEach((tpl) => {
        items.push({
          id: `company-create-${tpl.name}`,
          label: tpl.label,
          category: 'command' as PaletteCategory,
          icon: <IconCommand />,
          action: () => {
            import('../../../company/core/builtinTemplates').then(({ BUILTIN_TEMPLATES }) => {
              const template = BUILTIN_TEMPLATES.find((t) => t.name === tpl.name);
              if (!template) return;
              const s = useStore.getState();
              s.createCompany(tpl.name);
              for (const dept of template.departments) {
                s.addDepartment(dept.name, dept.leadName, dept.leadPreset);
                const fresh = useStore.getState();
                const lastDept = fresh.company?.departments[fresh.company.departments.length - 1];
                if (lastDept) {
                  for (const member of dept.members) {
                    useStore.getState().addMember(lastDept.id, member.name, member.preset);
                  }
                }
              }
              // Set CEO to current workspace
              const current = useStore.getState();
              if (current.company) {
                current.setCeoWorkspace(current.activeWorkspaceId);
                useStore.setState((s) => {
                  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
                  if (ws) ws.companyRole = 'ceo';
                });
              }
              useStore.getState().setSidebarMode('company');
            });
            setVisible(false);
          },
        });
      });

      items.push({
        id: 'company-create-custom',
        label: 'Company: Create Custom...',
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: () => {
          const name = prompt('Company name:');
          if (name?.trim()) {
            useStore.getState().createCompany(name.trim());
            const s = useStore.getState();
            if (s.company) {
              s.setCeoWorkspace(s.activeWorkspaceId);
              useStore.setState((st) => {
                const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
                if (ws) ws.companyRole = 'ceo';
              });
            }
            useStore.getState().setSidebarMode('company');
          }
          setVisible(false);
        },
      });
    } else if (COMPANY_MODE_ENABLED) {
      items.push({
        id: 'company-provision-all',
        label: 'Company: Provision All Members',
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: () => {
          import('../../../company/renderer/provisioner').then(({ spawnCompany }) => {
            const s = useStore.getState();
            const c = s.company;
            if (!c) return;
            spawnCompany({
              companyName: c.name,
              skipPermissions: c.skipPermissions || false,
              workDir: c.workDir,
              departments: c.departments.map((d) => ({
                name: d.name,
                leadName: d.members.find((m) => m.id === d.leadId)?.name || 'Lead',
                members: d.members.filter((m) => m.id !== d.leadId).map((m) => ({ name: m.name, preset: m.preset })),
              })),
            });
          });
          setVisible(false);
        },
      });

      items.push({
        id: 'company-destroy',
        label: 'Company: Destroy',
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: () => {
          useStore.getState().destroyCompany();
          useStore.getState().setSidebarMode('workspaces');
          setVisible(false);
        },
      });

      items.push({
        id: 'company-view-tab',
        label: 'Company: Show Company Tab',
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: () => {
          useStore.getState().setSidebarMode('company');
          if (!useStore.getState().sidebarVisible) useStore.getState().toggleSidebar();
          setVisible(false);
        },
      });
    }

    // Project config commands (X5 wmux.json). Trusted projects expose their
    // custom commands + layout apply; anything else (untrusted / stale /
    // denied / invalid) collapses to a single "Review…" entry that opens the
    // trust dialog — display-only until the user approves the file.
    const activeProject = activeWorkspaceId ? projectConfigs[activeWorkspaceId] : undefined;
    if (activeProject?.found && activeWorkspaceId) {
      if (activeProject.trust === 'trusted') {
        for (const cmd of activeProject.config?.commands ?? []) {
          items.push({
            id: `project-cmd-${cmd.id}`,
            label: `${t('palette.cmd.projectPrefix')}${cmd.title}`,
            category: 'command' as PaletteCategory,
            icon: <IconCommand />,
            action: () => {
              void runProjectCommand(activeWorkspaceId, cmd.id);
              setVisible(false);
            },
          });
        }
        if (activeProject.config?.layout) {
          items.push({
            id: 'project-apply-layout',
            label: t('palette.cmd.projectApplyLayout'),
            category: 'command' as PaletteCategory,
            icon: <IconGrid />,
            action: () => {
              void applyProjectLayoutFresh(activeWorkspaceId);
              setVisible(false);
            },
          });
        }
      } else if (activeProject.trust !== 'denied') {
        // untrusted / stale / invalid → a single review entry point.
        // 'denied' shows NOTHING here (plan table: badge only) — the user
        // explicitly said no, so the dim sidebar badge stays the sole
        // re-evaluation entry point.
        items.push({
          id: 'project-review',
          label: t('palette.cmd.projectReview'),
          category: 'command' as PaletteCategory,
          icon: <IconCommand />,
          action: () => {
            useStore.getState().setProjectDialogWsId(activeWorkspaceId);
            setVisible(false);
          },
        });
      }
    }

    // Layout template commands
    for (const tmpl of layoutTemplates) {
      items.push({
        id: `template-${tmpl.id}`,
        label: `${t('palette.cmd.layoutPrefix')}${tmpl.name}`,
        category: 'command' as PaletteCategory,
        icon: <IconGrid />,
        action: () => {
          useStore.getState().applyLayoutTemplate(tmpl.id);
          setVisible(false);
        },
      });
      // #1237 — the non-destructive twin: re-fit the RUNNING panes into the
      // template instead of replacing them with empty leaves.
      items.push({
        id: `snap-template-${tmpl.id}`,
        label: `${t('palette.cmd.snapPrefix')}${tmpl.name}`,
        category: 'command' as PaletteCategory,
        icon: <IconGrid />,
        action: () => {
          useStore.getState().snapToLayoutTemplate(tmpl.id);
          setVisible(false);
        },
      });
    }

    items.push({
      id: 'save-layout',
      label: t('palette.cmd.saveLayout'),
      category: 'command' as PaletteCategory,
      icon: <IconSave />,
      action: () => {
        const name = prompt('Template name:');
        if (name?.trim()) useStore.getState().saveLayoutTemplate(name.trim());
        setVisible(false);
      },
    });

    // Plugin-contributed commands (B-1 ui.commands). Trusted plugins only —
    // the same mount gate the panel hosts apply. Execution posts a
    // kind:'command' envelope to the plugin's frame; if the frame isn't
    // mounted yet, pluginFrameRegistry queues it and asks PluginPanels to
    // expand the panel so the frame comes up and flushes the queue.
    for (const plugin of plugins) {
      if (plugin.trustStatus !== 'trusted' || !plugin.contributes.commands) continue;
      for (const cmd of plugin.contributes.commands) {
        items.push({
          id: `plugin-${plugin.name}-${cmd.id}`,
          label: `${plugin.name}: ${cmd.title}`,
          category: 'command' as PaletteCategory,
          icon: <IconCommand />,
          action: () => {
            postPluginCommand(plugin.name, cmd.id);
            setVisible(false);
          },
        });
      }
    }

    // Recent terminal commands — show most recent first, max 20
    const recentReversed = [...recentCommands].reverse().slice(0, 20);
    for (const cmd of recentReversed) {
      items.push({
        id: `recent-${cmd}`,
        label: cmd,
        category: 'recent' as PaletteCategory,
        icon: (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ),
        action: () => {
          const ws = useStore.getState().workspaces.find(
            (w) => w.id === useStore.getState().activeWorkspaceId,
          );
          if (!ws) { togglePalette(); return; }
          const findPaneLeaf = (pane: import('../../../shared/types').Pane, id: string): import('../../../shared/types').PaneLeaf | null => {
            if (pane.id === id && pane.type === 'leaf') return pane;
            if (pane.type === 'branch') {
              for (const child of pane.children) {
                const found = findPaneLeaf(child, id);
                if (found) return found;
              }
            }
            return null;
          };
          const pane = findPaneLeaf(ws.rootPane, ws.activePaneId);
          if (pane) {
            const surface = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
            // Never into a shell the chat-v2 view hides.
            if (surface?.ptyId && !isChatV2Covering(surface.ptyId)) {
              // Route through the paste chunker. Recent commands originate
              // from the user's `inputBuffer`, which accumulates raw paste
              // payloads (`useTerminal.ts: terminal.onData`) — so a
              // previously-pasted multi-line snippet can be re-emitted
              // here. Chunking normalizes CRLF, paces IPC, and keeps the
              // payload under the main process's 100KB silent backstop.
              const surfacePtyId = surface.ptyId;
              void pastePtyChunked(
                (d) => window.electronAPI.pty.write(surfacePtyId, d),
                cmd,
                null,
              ).catch((err) => console.error('[wmux:palette] chunk write failed:', err));
            }
          }
          togglePalette();
        },
      });
    }

    return items;
  }, [workspaces, activeWorkspaceId, activeWorkspaceForItems, activeTask, layoutTemplates, setVisible, ipcInvoke, recentCommands, togglePalette, plugins, projectConfigs, t]);

  // -------------------------------------------------------------------------
  // Filtered + scored results — useMemo to cache across renders
  // -------------------------------------------------------------------------

  const results = useMemo((): PaletteItemData[] => {
    const all = buildItems();
    if (!query.trim()) return all;

    return all
      .map((item) => ({ item, score: fuzzyScore(item.label, query.trim()) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (b.score as number) - (a.score as number))
      .map((x) => x.item);
  }, [buildItems, query]);

  // -------------------------------------------------------------------------
  // Reset state when opened
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Closing mid-recording (backdrop click) must not leave the recorder
    // listening behind a palette that is gone.
    setRecording(null);
    setRecordNote(null);
    keyConflictOpenRef.current = false;
    setKeyConflict(null);
    if (visible) {
      setQuery('');
      setActiveIdx(0);
      // Defer focus to ensure the DOM has rendered
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [visible]);

  // -------------------------------------------------------------------------
  // Shortcut recording
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!recording) return;
    // useKeyboard stands down while this is set, so a chord that is already
    // a shortcut reaches the recorder instead of running.
    setKeyCaptureActive(true);
    // The search input just unmounted, and focus fell back to the terminal.
    // With a Hangul IME on, keys pressed while recording would compose there
    // and the text would reach the shell. A focused non-editable prompt has
    // no composition, so focus that.
    recordingRef.current?.focus();
    const finish = () => {
      setRecording(null);
      setRecordNote(null);
    };
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { finish(); return; }
      // A bare Backspace / Delete can never be a shortcut (it needs a
      // modifier), so it is free to mean "take the key off".
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
        clearShortcut(recording);
        finish();
        return;
      }
      const combo = comboFromEvent(e);
      if (combo === null) return; // only modifiers held so far
      // Recorded on an IME `Process` keydown, the follow-up keydown would
      // otherwise arrive after the recorder closed and run the new binding.
      shortcutPressGuard.noteActed(e);
      const problem = rebindProblemText(recording, combo);
      if (problem) { setRecordNote(problem); return; }
      const conflict = customKeyConflict(recording, combo);
      if (conflict) {
        keyConflictOpenRef.current = true;
        setKeyConflict({ conflict, action: recording, combo });
        finish();
        return;
      }
      setShortcutOverride(recording, combo);
      finish();
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      setKeyCaptureActive(false);
      // The search input was swapped out for the prompt; give it focus back
      // (unless a key conflict dialog took over, which hands it back itself).
      requestAnimationFrame(() => { if (!keyConflictOpenRef.current) inputRef.current?.focus(); });
    };
  }, [recording, setKeyCaptureActive, setShortcutOverride]);

  const closeKeyConflict = (useAnyway: boolean) => {
    if (useAnyway && keyConflict) setShortcutOverride(keyConflict.action, keyConflict.combo);
    keyConflictOpenRef.current = false;
    setKeyConflict(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // -------------------------------------------------------------------------
  // Keep activeIdx in bounds when results change
  // -------------------------------------------------------------------------

  useEffect(() => {
    setActiveIdx((prev) => Math.min(prev, Math.max(results.length - 1, 0)));
  }, [results.length]);

  // -------------------------------------------------------------------------
  // Scroll active item into view
  // -------------------------------------------------------------------------

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector<HTMLElement>('[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // -------------------------------------------------------------------------
  // Keyboard navigation inside palette
  // -------------------------------------------------------------------------

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setVisible(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((prev) => (prev + 1) % Math.max(results.length, 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((prev) => (prev - 1 + Math.max(results.length, 1)) % Math.max(results.length, 1));
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const shortcut = results[activeIdx]?.shortcut;
      if (shortcut) startRecording(shortcut);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      results[activeIdx]?.action();
      return;
    }
  };

  const activeShortcut = results[activeIdx]?.shortcut;
  const setShortcutKeyHint = platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter';

  if (!visible) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ backgroundColor: 'var(--bg-overlay-scrim, rgba(0, 0, 0, 0.55))' }}
      onMouseDown={(e) => {
        // Close when clicking the backdrop, not the palette itself
        if (e.target === e.currentTarget) setVisible(false);
      }}
    >
      {/* Palette container — the quiet popover panel (ui-popover +
          ui-surface: 14px, hairline, one soft shadow). */}
      <div
        className="ui-popover ui-surface w-[480px] max-h-[60vh] flex flex-col overflow-hidden"
        style={{ padding: 0 }}
        onMouseDown={(e) => e.stopPropagation()}
        {...tokenAttrs('bgBase', 'bg')}
      >
        {/* Search input row */}
        <div
          className="flex items-center gap-2.5 px-4 py-3"
          style={{ borderBottom: '1px solid var(--surface-hairline)' }}
        >
          <span className="shrink-0 text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')}>
            <IconSearch />
          </span>
          {recording ? (
            <span
              ref={recordingRef}
              tabIndex={-1}
              className="flex-1 truncate text-[14px] leading-5 text-[var(--text-main)] outline-none"
              role="status"
              data-testid="palette-recording"
            >
              {t('settings.sc.pressNewKey', { name: describeShortcut(recording) })}
            </span>
          ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent text-[var(--text-main)] text-[14px] leading-5 placeholder-[var(--text-muted)] outline-none"
            spellCheck={false}
            autoComplete="off"
            {...tokenAttrs('textMain', 'text')}
          />
          )}
          <kbd className="ui-kbd shrink-0" {...tokenAttrs('textSub', 'text')}>
            ESC
          </kbd>
        </div>

        {recording && recordNote && (
          <p
            role="alert"
            className="px-4 py-2 text-[12px] leading-4"
            style={{ color: 'var(--accent-yellow)', borderBottom: '1px solid var(--surface-hairline)' }}
          >
            {recordNote}
          </p>
        )}

        {/* Results list */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--text-sub)]">
              {t('palette.noResults')} &ldquo;{query}&rdquo;
            </div>
          ) : (
            results.map((item, idx) => (
              <div
                key={item.id}
                data-active={idx === activeIdx ? 'true' : undefined}
                // The pointer moves the selection, so the keyboard-active row
                // and the hovered row are never two different highlights.
                // mousemove, not mouseenter: rows scrolled under a still
                // pointer by arrow keys must not steal the selection back.
                onMouseMove={() => { if (idx !== activeIdx) setActiveIdx(idx); }}
              >
                <PaletteItem
                  item={item}
                  isActive={idx === activeIdx}
                  onClick={item.action}
                  combo={item.shortcut ? comboByAction.get(item.shortcut) ?? null : undefined}
                  onSetShortcut={startRecording}
                />
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center gap-4 px-4 py-2.5"
          style={{ borderTop: '1px solid var(--surface-hairline)' }}
        >
          {recording ? (
            <>
              <span className="ui-note flex items-center gap-1.5">
                <kbd className="ui-kbd">Backspace</kbd>
                {t('palette.removeShortcut')}
              </span>
              <span className="ui-note flex items-center gap-1.5">
                <kbd className="ui-kbd">Esc</kbd>
                {t('palette.cancel')}
              </span>
            </>
          ) : (
            <>
              <span className="ui-note flex items-center gap-1.5">
                <kbd className="ui-kbd">↑↓</kbd>
                {t('palette.navigate')}
              </span>
              <span className="ui-note flex items-center gap-1.5">
                <kbd className="ui-kbd">Enter</kbd>
                {t('palette.select')}
              </span>
              {activeShortcut && (
                <span className="ui-note flex items-center gap-1.5">
                  <kbd className="ui-kbd">{setShortcutKeyHint}</kbd>
                  {t('palette.setShortcut')}
                </span>
              )}
              <span className="ui-note flex items-center gap-1.5">
                <kbd className="ui-kbd">Esc</kbd>
                {t('palette.close')}
              </span>
            </>
          )}
        </div>
      </div>
      {keyConflict && (
        <KeyConflictConfirm
          conflict={keyConflict.conflict}
          onConfirm={() => closeKeyConflict(true)}
          onCancel={() => closeKeyConflict(false)}
        />
      )}
    </div>
  );
}

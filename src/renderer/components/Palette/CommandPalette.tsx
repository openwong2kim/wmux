import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import PaletteItem, { type PaletteItemData, type PaletteCategory } from './PaletteItem';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from '../../utils/ptyCreateOptions';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { tokenAttrs } from '../../themes';

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

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

export default function CommandPalette() {
  const t = useT();
  const visible = useStore((s) => s.commandPaletteVisible);
  const setVisible = useStore((s) => s.setCommandPaletteVisible);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const layoutTemplates = useStore((s) => s.layoutTemplates);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { invoke: ipcInvoke } = useIpc();

  // -------------------------------------------------------------------------
  // Build item list
  // -------------------------------------------------------------------------

  const recentCommands = useStore((s) => s.recentCommands);
  const togglePalette = useStore((s) => s.toggleCommandPalette);

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
          setVisible(false);
        },
      });
    });

    // Surfaces — gather from active workspace leaf panes
    const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
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
    const commands: Array<{ label: string; action: () => void }> = [
      {
        label: t('palette.cmd.toggleSidebar'),
        action: () => { useStore.getState().toggleSidebar(); setVisible(false); },
      },
      {
        label: t('palette.cmd.splitRight'),
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) state.splitPane(ws.activePaneId, 'horizontal');
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.splitDown'),
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) state.splitPane(ws.activePaneId, 'vertical');
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.newWorkspace'),
        action: () => { useStore.getState().addWorkspace(); setVisible(false); },
      },
      {
        label: t('palette.cmd.newSurface'),
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) {
            // Issue #175: new tabs honor profile.startupCwd > global startupDirectory.
            const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory });
            void ipcInvoke<{ id: string }>(() =>
              window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ workspaceId: ws.id, cwd }, state.defaultShell), ws.profile))
            ).then((result) => {
              if (result.ok) {
                useStore.getState().addSurface(ws.activePaneId, result.data.id, 'Terminal', '');
              }
            });
          }
          setVisible(false);
        },
      },
      {
        label: t('palette.cmd.showNotifications'),
        action: () => { useStore.getState().setNotificationPanelVisible(true); setVisible(false); },
      },
      {
        label: t('palette.cmd.openBrowser'),
        action: () => {
          const state = useStore.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) {
            // splitPane returns false when the workspace has hit the leaf cap
            // (paneSlice toasts the user). Bail out so the browser surface
            // does not get attached to the still-active original pane.
            const ok = state.splitPane(ws.activePaneId, 'horizontal');
            if (ok) {
              const newState = useStore.getState();
              const newWs = newState.workspaces.find((w) => w.id === newState.activeWorkspaceId);
              if (newWs) {
                newState.addBrowserSurface(newWs.activePaneId);
              }
            }
          }
          setVisible(false);
        },
      },
    ];

    commands.forEach((cmd, i) => {
      items.push({
        id: `cmd-${i}`,
        label: cmd.label,
        category: 'command' as PaletteCategory,
        icon: <IconCommand />,
        action: cmd.action,
      });
    });

    // Company commands
    const state = useStore.getState();
    const hasCompany = !!state.company;

    if (!hasCompany) {
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
    } else {
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
            if (surface?.ptyId) {
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
  }, [workspaces, activeWorkspaceId, layoutTemplates, setVisible, ipcInvoke, recentCommands, togglePalette]);

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
    if (e.key === 'Enter') {
      e.preventDefault();
      results[activeIdx]?.action();
      return;
    }
  };

  if (!visible) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      onMouseDown={(e) => {
        // Close when clicking the backdrop, not the palette itself
        if (e.target === e.currentTarget) setVisible(false);
      }}
    >
      {/* Palette container */}
      <div
        className="w-[480px] max-h-[60vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.7)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        {...tokenAttrs('bgBase', 'bg')}
        {...tokenAttrs('bgSurface', 'border')}
      >
        {/* Search input row */}
        <div
          className="flex items-center gap-2.5 px-4 py-3"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          <span className="shrink-0 text-[var(--text-subtle)]" {...tokenAttrs('textSub', 'text')} data-derived="textSubtle">
            <IconSearch />
          </span>
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
            className="flex-1 bg-transparent text-[var(--text-main)] text-sm placeholder-[var(--text-muted)] outline-none"
            spellCheck={false}
            autoComplete="off"
            {...tokenAttrs('textMain', 'text')}
          />
          <kbd
            className="shrink-0 text-xs text-[var(--text-muted)] px-1.5 py-0.5 rounded"
            style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
            {...tokenAttrs('textMuted', 'text')}
            {...tokenAttrs('bgSurface', 'border')}
            data-derived="bgOverlay"
          >
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="overflow-y-auto flex-1">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              {t('palette.noResults')} &ldquo;{query}&rdquo;
            </div>
          ) : (
            results.map((item, idx) => (
              <div key={item.id} data-active={idx === activeIdx ? 'true' : undefined}>
                <PaletteItem
                  item={item}
                  isActive={idx === activeIdx}
                  onClick={item.action}
                />
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center gap-3 px-4 py-2"
          style={{ borderTop: '1px solid var(--bg-surface)', backgroundColor: 'var(--bg-mantle)' }}
          {...tokenAttrs('bgMantle', 'bg')}
        >
          <span className="text-xs text-[var(--text-muted)]">
            <kbd
              className="px-1 py-0.5 rounded mr-0.5"
              style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
            >
              ↑↓
            </kbd>{' '}
            {t('palette.navigate')}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            <kbd
              className="px-1 py-0.5 rounded mr-0.5"
              style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
            >
              Enter
            </kbd>{' '}
            {t('palette.select')}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            <kbd
              className="px-1 py-0.5 rounded mr-0.5"
              style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
            >
              Esc
            </kbd>{' '}
            {t('palette.close')}
          </span>
        </div>
      </div>
    </div>
  );
}

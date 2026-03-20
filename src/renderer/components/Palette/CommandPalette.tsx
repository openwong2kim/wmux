import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import PaletteItem, { type PaletteItemData, type PaletteCategory } from './PaletteItem';
import { useT } from '../../hooks/useT';

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

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Build item list
  // -------------------------------------------------------------------------

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
            window.electronAPI.pty.create().then((result: { id: string }) => {
              useStore.getState().addSurface(ws.activePaneId, result.id, 'Terminal', '');
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
            state.splitPane(ws.activePaneId, 'horizontal');
            const newState = useStore.getState();
            const newWs = newState.workspaces.find((w) => w.id === newState.activeWorkspaceId);
            if (newWs) {
              newState.addBrowserSurface(newWs.activePaneId);
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

    return items;
  }, [workspaces, activeWorkspaceId, setVisible]);

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
      >
        {/* Search input row */}
        <div
          className="flex items-center gap-2.5 px-4 py-3"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          <span className="shrink-0 text-[var(--text-subtle)]">
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
          />
          <kbd
            className="shrink-0 text-xs text-[var(--text-muted)] px-1.5 py-0.5 rounded"
            style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
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

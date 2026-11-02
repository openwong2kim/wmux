import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useT } from '../../hooks/useT';
import { displayCombo } from '../../../shared/keymap';
import { shortcutPlatform } from '../../utils/shortcutBindings';
import { withShortcut } from '../../utils/shortcutLabel';
import { useStore } from '../../stores';
import { terminalRegistry } from '../../hooks/useTerminal';
import type { PaneSearchResult } from '../../../shared/types';
import { FOCUS_RING } from '../focusRing';

const MAX_HISTORY = 50;
const searchHistory: string[] = [];

interface SearchBarProps {
  onFindNext: (text: string, useRegex?: boolean) => void;
  onFindPrevious: (text: string, useRegex?: boolean) => void;
  onClose: () => void;
}

/**
 * Truncates result text for inline dropdown display so a single very long
 * matched line cannot blow out the dropdown width or wrap into many rows.
 */
function truncateMatch(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

export default function SearchBar({ onFindNext, onFindPrevious, onClose }: SearchBarProps) {
  const t = useT();
  const keyPlatform = shortcutPlatform();
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [allPanes, setAllPanes] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const savedQueryRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Cross-pane search state — read directly from searchSlice (T-C).
  // Selecting individual fields rather than the whole slice keeps re-renders
  // minimal: we only re-render when these specific values change.
  const searchResults = useStore((s) => s.searchResults);
  const searchTotalMatches = useStore((s) => s.searchTotalMatches);
  const searchQuery = useStore((s) => s.searchQuery);
  const runSearch = useStore((s) => s.runSearch);
  const clearCrossPaneSearch = useStore((s) => s.clearSearch);

  // Regex validation runs synchronously on every keystroke when the regex
  // toggle is on. We surface the SyntaxError message inline (red border +
  // tooltip) and SUPPRESS search execution — matching D6/F8.
  const regexError = useMemo<string | null>(() => {
    if (!useRegex) return null;
    if (!query) return null;
    try {
      // Construction is enough — we don't need to execute it here.
      // eslint-disable-next-line no-new
      new RegExp(query);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [useRegex, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // I5: do NOT clear cross-pane state on unmount. The results panel (T-F)
  // is meant to be independently dismissable per D8 — wiping panel state
  // every time the user toggles Ctrl+F closed would defeat the sticky
  // model. Cross-pane state is cleared explicitly when the user leaves
  // All-Panes mode via `toggleAllPanes` (below).

  const runCrossPaneSearch = useCallback(
    (q: string) => {
      if (!q.trim()) return;
      if (regexError) return; // suppress on invalid regex (D6)
      void runSearch(q, useRegex);
    },
    [regexError, runSearch, useRegex],
  );

  const recordHistory = useCallback((q: string) => {
    if (!q.trim()) return;
    const existing = searchHistory.indexOf(q);
    if (existing >= 0) searchHistory.splice(existing, 1);
    searchHistory.push(q);
    if (searchHistory.length > MAX_HISTORY) searchHistory.shift();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (searchHistory.length === 0) return;
        if (historyIdx === -1) savedQueryRef.current = query;
        const newIdx = Math.min(historyIdx + 1, searchHistory.length - 1);
        setHistoryIdx(newIdx);
        setQuery(searchHistory[searchHistory.length - 1 - newIdx]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setQuery(savedQueryRef.current);
          return;
        }
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setQuery(searchHistory[searchHistory.length - 1 - newIdx]);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (query.trim()) {
          recordHistory(query);
          setHistoryIdx(-1);
        }
        if (allPanes) {
          // Cross-pane: Enter (or Shift+Enter) re-runs the search. There's
          // no "next/prev" semantic since results are listed in the dropdown
          // rather than highlighted in a single buffer.
          runCrossPaneSearch(query);
          return;
        }
        if (regexError) return; // single-pane: also suppress on invalid regex
        if (e.shiftKey) {
          onFindPrevious(query, useRegex);
        } else {
          onFindNext(query, useRegex);
        }
      }
    },
    [
      query,
      useRegex,
      historyIdx,
      onFindNext,
      onFindPrevious,
      allPanes,
      recordHistory,
      runCrossPaneSearch,
      regexError,
    ],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setHistoryIdx(-1);
  }, []);

  const toggleRegex = useCallback(() => {
    setUseRegex((prev) => !prev);
  }, []);

  const toggleAllPanes = useCallback(() => {
    setAllPanes((prev) => {
      const next = !prev;
      // Leaving All Panes mode → wipe any lingering cross-pane state so the
      // dropdown disappears and T-F's panel doesn't reopen on next entry.
      if (!next) {
        clearCrossPaneSearch();
      }
      return next;
    });
  }, [clearCrossPaneSearch]);

  // Click handler for an individual result row in the inline dropdown.
  // Safe-by-construction: if the pane (or its terminal instance) was disposed
  // between search execution and click, terminalRegistry.get returns
  // undefined and we silently no-op.
  const handleResultClick = useCallback(
    (r: PaneSearchResult) => {
      try {
        useStore.getState().setActivePane(r.paneId);
      } catch {
        // setActivePane will no-op for unknown ids, but we guard anyway.
      }
      const term = terminalRegistry.get(r.ptyId);
      if (term) {
        // I6: use physicalBaseY (xterm expects a physical row index, not a
        // post-wrap-coalesce logical line index). M3: wrap in try/catch —
        // scrollToLine can throw if the buffer has rotated since the search
        // executed.
        try {
          term.scrollToLine(r.physicalBaseY);
        } catch {
          // pane is at least focused; user can re-search to refresh.
        }
      }
    },
    [],
  );

  // Whether the inline dropdown is appropriate. The panel (T-F) handles the
  // >10 case, so we render either the dropdown OR the "open panel" hint —
  // never both.
  const showDropdown =
    allPanes && searchQuery.length > 0 && searchResults.length > 0 && searchResults.length <= 10;
  const showPanelHint =
    allPanes && searchQuery.length > 0 && searchResults.length > 10;
  const showNoResults =
    allPanes &&
    searchQuery.length > 0 &&
    searchResults.length === 0 &&
    !regexError &&
    // Only after the runSearch promise has resolved — we approximate that by
    // checking that searchQuery (set by the slice on success) matches what
    // the user typed. Avoids a flicker of "No results" between keystroke and
    // response.
    searchQuery === query.trim();

  const inputBorderColor = regexError ? 'var(--accent-red)' : 'transparent';

  return (
    <div
      className="absolute top-0 right-2 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
      style={{ minWidth: '320px' }}
    >
      {/* Bar row — recessed field attached to the pane's top chrome. The
          accent-blue focus-within ring lives on .ui-search-bar; the input's own
          red border (invalid regex) still shows inside it. */}
      <div className="ui-search-bar flex items-center gap-1 px-2 py-1.5 rounded-b-md">
        {/* Search icon */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          className="shrink-0 text-[var(--text-subtle)]"
          style={{ color: 'var(--text-subtle)' }}
        >
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={t('search.placeholder')}
          title={regexError ? t('search.invalidRegex', { message: regexError }) : undefined}
          className="flex-1 bg-transparent outline-none text-xs px-1 rounded-sm"
          style={{
            color: 'var(--text-main)',
            caretColor: 'var(--accent-cursor)',
            minWidth: 0,
            border: `1px solid ${inputBorderColor}`,
          }}
          spellCheck={false}
        />

        {/* All Panes toggle — tinted-active pill (not a solid accent fill). */}
        <button
          onClick={toggleAllPanes}
          title={t('search.allPanes')}
          aria-pressed={allPanes}
          className={`ui-toggle ${allPanes ? 'ui-toggle-on' : ''} ${FOCUS_RING} h-5 px-1.5 shrink-0`}
        >
          <span className="text-[10px] font-bold leading-none">{t('search.allPanes')}</span>
        </button>

        {/* Regex toggle — tinted-active pill. */}
        <button
          onClick={toggleRegex}
          title={t('search.regexMode')}
          aria-pressed={useRegex}
          className={`ui-toggle ${useRegex ? 'ui-toggle-on' : ''} ${FOCUS_RING} w-5 h-5 shrink-0`}
        >
          <span className="text-[10px] font-bold leading-none">.*</span>
        </button>

        {/* Previous / Next — only shown in single-pane mode (no concept of
            "next match" when results are listed cross-pane). */}
        {!allPanes && (
          <>
            <button
              onClick={() => {
                if (regexError) return;
                onFindPrevious(query, useRegex);
              }}
              title={withShortcut(t('search.prevTooltip'), displayCombo('Shift+Enter', keyPlatform))}
              className={`ui-icon-btn ${FOCUS_RING} w-5 h-5 shrink-0`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 8L2 5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 8L5 5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <button
              onClick={() => {
                if (regexError) return;
                onFindNext(query, useRegex);
              }}
              title={withShortcut(t('search.nextTooltip'), displayCombo('Enter', keyPlatform))}
              className={`ui-icon-btn ${FOCUS_RING} w-5 h-5 shrink-0`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}

        {/* Close */}
        <button
          onClick={onClose}
          title={withShortcut(t('search.closeTooltip'), displayCombo('Escape', keyPlatform))}
          className={`ui-icon-btn ui-icon-btn-danger ${FOCUS_RING} w-5 h-5 shrink-0`}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Inline dropdown — small result lists (≤10). T-F's panel handles
          larger result sets via searchPanelOpen + hysteresis. */}
      {showDropdown && (
        <ul
          className="mt-0.5 rounded-md shadow-lg overflow-hidden"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--bg-overlay)',
            maxHeight: '40vh',
            overflowY: 'auto',
            listStyle: 'none',
            padding: 0,
            margin: 0,
          }}
          role="listbox"
        >
          {searchResults.map((r, i) => (
            <li
              key={`${r.paneId}-${r.ptyId}-${r.lineIdx}-${i}`}
              role="option"
              aria-selected={false}
              onClick={() => handleResultClick(r)}
              className="flex items-baseline gap-2 px-2 py-1 cursor-pointer hover:bg-[var(--bg-overlay)]"
              style={{ fontSize: '11px', color: 'var(--text-main)' }}
            >
              <span
                className="shrink-0 font-medium"
                style={{ color: 'var(--text-sub2)', minWidth: '40px' }}
              >
                {r.paneLabel ?? t('search.unlabeled')}
              </span>
              <span className="shrink-0" style={{ color: 'var(--text-subtle)' }}>
                {t('search.matchedLine', { line: r.lineIdx + 1 })}
              </span>
              <span
                className="flex-1 truncate font-mono"
                style={{ color: 'var(--text-main)' }}
              >
                {truncateMatch(r.text)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* "Open panel" hint — for >10 results. The actual panel is rendered
          by T-F (SearchResultsPanel) reading the same searchSlice state. */}
      {showPanelHint && (
        <button
          onClick={() => {
            // Best-effort: clear the panel sticky-closed bit so T-F's
            // hysteresis logic can re-open it. We don't mutate panelOpen
            // ourselves — that's T-F's responsibility — but resetting the
            // sticky bit is safe and matches user intent ("open panel").
            useStore.setState((state) => {
              state.searchPanelStickyClosed = false;
              state.searchPanelOpen = true;
            });
          }}
          className="mt-0.5 px-2 py-1 rounded-md text-[11px] text-left hover:bg-[var(--bg-overlay)] transition-colors"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--bg-overlay)',
            color: 'var(--text-main)',
          }}
        >
          {t('search.showInPanel', { count: searchTotalMatches })}
        </button>
      )}

      {/* Empty-result hint */}
      {showNoResults && (
        <div
          className="mt-0.5 px-2 py-1 rounded-md text-[11px]"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--bg-overlay)',
            color: 'var(--text-subtle)',
          }}
        >
          {t('search.noResults')}
        </div>
      )}
    </div>
  );
}

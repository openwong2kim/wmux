/**
 * T7 — KeyboardCheatSheet (Plan 1.18, D5 + D11)
 *
 * Bottom-right fixed overlay, shown only when asked: the `?` prefix action
 * or Settings › Setup and reset. Lists the most useful keyboard shortcuts
 * and runs a 30-second auto-dismiss countdown (paused on hover, focus, or
 * window blur). It never opens by itself, so it has no "Don't show again".
 *
 * Design notes:
 * - A profile that opted out under the old automatic sheet keeps
 *   `cheatSheetDismissed`; asking for the sheet still shows it.
 * - Stays *below* the wizard modal in z-index — wizard is --z-dialog (70),
 *   we sit at --z-cheatsheet (40) so we never trap clicks meant for the
 *   wizard or auto-update prompt (--z-modal, 60).
 * - Keys come from the keymap defaults and are written by displayCombo, so
 *   the sheet says ⌘D / ⌃B on macOS and Ctrl+D / Ctrl+B elsewhere — the
 *   prefix (Ctrl+B) and bookmark (Ctrl+M) are literal Ctrl on every OS.
 *
 * The view is split into a dumb `<KeyboardCheatSheetView>` so the
 * presentation can be rendered (and snapshot-tested) without React's
 * effect machinery, while the default export wires up timers and store
 * subscriptions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import { t as translate } from '../i18n';
import Popover, { PopoverSection } from './ui/Popover';
import Button from './ui/Button';
import { defaultBindings, displayCombo, type ShortcutActionId } from '../../shared/keymap';
import { IconX } from './icons';

// ─── Constants ──────────────────────────────────────────────────────────────
export const CHEAT_SHEET_DURATION_MS = 30_000;
const TICK_MS = 100;

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

export type CheatSheetEntry = {
  /** i18n key (or English literal when no key has been wired yet) */
  label: string;
  /** Pre-rendered shortcut combo, e.g. "⌘D" or "Ctrl+B" */
  combo: string;
  /** When true, `label` is treated as a literal string (skip translation). */
  literal?: boolean;
};

/**
 * Build the shortcut list for the given platform.  Pure function so tests
 * can assert OS-specific output without rendering. Every key is read from
 * the keymap's defaults and written by the one formatter (displayCombo).
 */
export function buildShortcuts(platform: string | undefined): CheatSheetEntry[] {
  const os: NodeJS.Platform = platform === 'darwin' || platform === 'linux' ? platform : 'win32';
  const defaults = defaultBindings(os);
  const keyOf = (action: ShortcutActionId) => displayCombo(defaults.find((b) => b.action === action)?.combo ?? '', os);
  const show = (combo: string) => displayCombo(combo, os);
  return [
    { label: 'cheatSheet.splitHorizontal', combo: keyOf('splitHorizontal') },
    { label: 'cheatSheet.splitVertical', combo: keyOf('splitVertical') },
    { label: 'cheatSheet.newWorkspace', combo: keyOf('newWorkspace') },
    { label: 'cheatSheet.openSettings', combo: keyOf('openSettings') },
    { label: 'cheatSheet.commandPalette', combo: keyOf('commandPalette') },
    { label: 'cheatSheet.toggleSidebar', combo: keyOf('toggleSidebar') },
    // Ctrl+Tab is literal Ctrl on every OS (literalCtrl in the keymap).
    { label: 'cheatSheet.cyclePane', combo: keyOf('nextPane'), literal: false },
    // Ctrl+Shift+Arrow moves focus: pane focus within a workspace, or between
    // tiles when the multiview grid is showing (literal Ctrl on every OS).
    // TODO(T1): wire i18n key for cheat sheet "Move focus" entry.
    { label: 'Move focus', combo: show('Ctrl+Shift+Arrows'), literal: true },
    // Alt+Up/Down cycle workspaces (prev / next).
    // TODO(T1): wire i18n key for cheat sheet "Switch workspace" entry.
    { label: 'Switch workspace', combo: `${keyOf('prevWorkspace')} / ${keyOf('nextWorkspace')}`, literal: true },
    // The tmux prefix is literal Ctrl+B on every OS (isPrefixTrigger).
    // TODO(T1): wire i18n key for cheat sheet "tmux prefix" entry.
    { label: 'tmux prefix', combo: show('Ctrl+B'), literal: true },
    // Maximize / zoom the focused pane (prefix then z; press again to
    // restore). There is no always-visible button, so the sheet lists it.
    // TODO(T1): wire i18n key for cheat sheet "Maximize pane" entry.
    { label: 'Maximize pane', combo: `${show('Ctrl+B')} Z`, literal: true },
    // TODO(T1): wire i18n key for cheat sheet "Bookmark line" entry.
    { label: 'Bookmark line', combo: keyOf('addBookmark'), literal: true },
  ];
}

// ─── Presentational view ────────────────────────────────────────────────────

export interface KeyboardCheatSheetViewProps {
  shortcuts: CheatSheetEntry[];
  /** Title text (already translated). */
  title: string;
  /** Close button aria-label (already translated). */
  dismissLabel: string;
  /** Remaining countdown ratio in [0, 1]. */
  progress: number;
  onDismiss: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Translator for shortcut labels (i18n keys → strings). */
  translateLabel: (key: string) => string;
}

export function KeyboardCheatSheetView({
  shortcuts,
  title,
  dismissLabel,
  progress,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  translateLabel,
}: KeyboardCheatSheetViewProps) {
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <Popover
      role="region"
      padded
      aria-label={title}
      data-testid="keyboard-cheat-sheet"
      className="fixed bottom-4 right-4 z-[var(--z-cheatsheet)] w-[280px] max-w-[calc(100vw-2rem)] overflow-hidden"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <PopoverSection
        title={title}
        action={
          <Button
            variant="icon"
            className="-my-1 -mr-1 h-7 w-7 shrink-0"
            aria-label={dismissLabel}
            onClick={onDismiss}
            data-testid="keyboard-cheat-sheet-close"
          >
            <IconX size={12} />
          </Button>
        }
      >
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="keyboard-cheat-sheet-list">
          {shortcuts.map((entry) => (
            <li key={`${entry.label}-${entry.combo}`} className="flex items-center justify-between gap-3">
              <span className="truncate text-[13px] leading-5">{entry.literal ? entry.label : translateLabel(entry.label)}</span>
              <kbd className="ui-kbd" data-testid={`combo-${entry.label}`}>
                {entry.combo}
              </kbd>
            </li>
          ))}
        </ul>
        {/* Inside the last section, so that section stays the popover's last
            child and its bottom inset collapses; absolute, so it still spans
            the card's bottom edge. */}
        <div
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-[2px]"
          style={{
            width: `${clamped * 100}%`,
            backgroundColor: 'color-mix(in srgb, var(--text-main) 22%, transparent)',
            transition: 'width 100ms linear',
          }}
          data-testid="keyboard-cheat-sheet-progress"
        />
      </PopoverSection>
    </Popover>
  );
}

// ─── Default export: timer + store wiring ──────────────────────────────────

export default function KeyboardCheatSheet() {
  const cheatSheetDismissed = useStore((s) => s.cheatSheetDismissed);
  // One-shot force-show triggered by the `?` prefix action — re-displays the
  // overlay even after the user has permanently dismissed it, and resets the
  // local hidden/countdown state for a fresh viewing.
  const cheatSheetForceShown = useStore((s) => s.cheatSheetForceShown);
  const setCheatSheetForceShown = useStore((s) => s.setCheatSheetForceShown);
  const t = useT();

  const [hidden, setHidden] = useState(false);
  const [remainingMs, setRemainingMs] = useState(CHEAT_SHEET_DURATION_MS);
  // Pause flags: hover, focus, document hidden.  Stored in refs so tick()
  // sees the latest value without re-creating the interval.
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const docHiddenRef = useRef(false);

  const platform = useMemo(() => {
    // electronAPI.platform was added by 1.14 OS-aware shortcut work — see
    // src/preload/preload.ts:22.  Defensive default for non-Electron runs
    // (tests).
    if (typeof window === 'undefined') return undefined;
    const api = (window as Window & { electronAPI?: { platform?: string } }).electronAPI;
    return api?.platform;
  }, []);

  const shortcuts = useMemo(() => buildShortcuts(platform), [platform]);

  // When the prefix `?` action fires, reset local state so a previously
  // expired/hidden overlay re-renders with a fresh 30s countdown.
  useEffect(() => {
    if (!cheatSheetForceShown) return;
    setHidden(false);
    setRemainingMs(CHEAT_SHEET_DURATION_MS);
  }, [cheatSheetForceShown]);

  // Countdown tick — paused when any of the three flags is true.
  useEffect(() => {
    if ((cheatSheetDismissed && !cheatSheetForceShown) || hidden) return;

    const interval = setInterval(() => {
      if (hoverRef.current || focusRef.current || docHiddenRef.current) return;
      setRemainingMs((prev) => {
        const next = prev - TICK_MS;
        if (next <= 0) {
          setHidden(true);
          // Clear the one-shot override so a subsequent `?` press can flip
          // the selector value and re-trigger the force-show effect. Without
          // this reset, force-shown stays `true` forever after the first
          // countdown expires and the next `?` becomes a no-op.
          if (cheatSheetForceShown) setCheatSheetForceShown(false);
          return 0;
        }
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [cheatSheetDismissed, cheatSheetForceShown, hidden, setCheatSheetForceShown]);

  // visibilitychange listener — pause when window is hidden.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      docHiddenRef.current = document.visibilityState === 'hidden';
    };
    // Initialize from current state.
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const onDismiss = useCallback(() => {
    setHidden(true);
    // Clear the one-shot override so the next `?` press triggers a re-show.
    if (cheatSheetForceShown) setCheatSheetForceShown(false);
  }, [cheatSheetForceShown, setCheatSheetForceShown]);

  // It belongs to the page it was opened on: switching rail pages closes it,
  // and so does a click anywhere outside it.
  const appRoute = useStore((s) => s.appRoute);
  const openedOn = useRef(appRoute);
  useEffect(() => {
    if (hidden) {
      openedOn.current = appRoute;
      return;
    }
    if (appRoute !== openedOn.current) onDismiss();
  }, [appRoute, hidden, onDismiss]);
  useEffect(() => {
    if (hidden || (cheatSheetDismissed && !cheatSheetForceShown) || typeof document === 'undefined') return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-testid="keyboard-cheat-sheet"]')) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [hidden, cheatSheetDismissed, cheatSheetForceShown, onDismiss]);

  const onMouseEnter = useCallback(() => {
    hoverRef.current = true;
  }, []);
  const onMouseLeave = useCallback(() => {
    hoverRef.current = false;
  }, []);
  const onFocus = useCallback(() => {
    focusRef.current = true;
  }, []);
  const onBlur = useCallback(() => {
    focusRef.current = false;
  }, []);

  // Force-show wins over the permanent dismissal so `?` always works.
  if (hidden) return null;
  if (cheatSheetDismissed && !cheatSheetForceShown) return null;

  const progress = remainingMs / CHEAT_SHEET_DURATION_MS;

  return (
    <KeyboardCheatSheetView
      shortcuts={shortcuts}
      title={t('cheatSheet.title')}
      dismissLabel={t('cheatSheet.dismiss')}
      progress={progress}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      translateLabel={(key) => translate(key)}
    />
  );
}

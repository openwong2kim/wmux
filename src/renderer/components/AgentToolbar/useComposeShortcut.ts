import { useEffect } from 'react';
import { useStore } from '../../stores';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { matchesDisabledShortcut } from '../../../shared/keymap';
import { isComposeChord, composeOwnerHost } from '../../terminal/composeChord';

/**
 * ⌘G / Ctrl+G toggles Rich Input on the focused terminal.
 *
 * Mounted by ToolbarHost ABOVE its enabled gate, because the binding is
 * documented to survive the inject-chrome setting being off. Keeping it inside
 * AgentToolbar tied the shortcut to the bar's own mount, which silently
 * dropped it for anyone on a minimal chrome preset.
 *
 * It only sets `toolbarPopover`; the bar renders the popover. With the bar
 * hidden the state still flips, and the bar holds itself open for it — that is
 * the keyboard route in.
 *
 * #1280 — which keydowns ARE the chord is not decided here. The old inline
 * test, `(ctrlKey || metaKey) && (key === 'g' || key === 'G')`, accepted a
 * SUPERSET: `key` is 'G' precisely when Shift is held, so Ctrl+Shift+G — the
 * clearMultiview binding — also toggled Rich Input, and so did Ctrl+Alt+G.
 * Worse, useTerminal's pane gate had its own opinion of the same key, and
 * every condition one gate applied that the other could not see left the key
 * silently dead. Both gates now call one pure predicate; see
 * terminal/composeChord.ts.
 *
 * Note the one case this gate still loses: a user who bound a CUSTOM
 * keybinding to Ctrl+G wins via useKeyboard's `stopImmediatePropagation`, so
 * Rich Input never opens for them. Their explicit rebind beating the built-in
 * is the right precedence; it is just silent.
 */
export function useComposeShortcut(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = window.electronAPI?.platform === 'darwin';
      const platform: NodeJS.Platform = isMac ? 'darwin' : 'win32';
      if (!isComposeChord(e, platform)) return;
      // Key repeat must not flap the popover open and shut. The pane gate
      // swallows repeats too (the chord predicate accepts them), so this is a
      // deliberate NON-REPEATING chord, not a gate disagreement: a held Ctrl+G
      // toggles once and is then inert.
      if (e.repeat) return;
      // Inspect mode owns the keyboard while it is armed — useKeyboard applies
      // the same early-out to every global shortcut. The pane gate checks it
      // too, so the key is not merely swallowed here.
      if (useStore.getState().inspectModeActive) return;
      // A combo the user switched off in Settings → Shortcuts belongs to the
      // pane; useTerminal's disabled gate writes the byte for it.
      if (matchesDisabledShortcut(
        useStore.getState().disabledShortcuts, e, platform,
      )) return;
      // Don't hijack the chord while the user is typing in a field that this
      // toolbar owns (Rich Input's textarea, snippet inputs). The focused
      // terminal's own xterm textarea is NOT one of those — it is the primary
      // entry point and must still toggle.
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-testid="agent-toolbar"], [data-toolbar-owned]')) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
      }
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      const activePtyId = focusedTerminalPtyId(ws);
      if (!activePtyId) return;
      // Ownership, checked on THIS gate too (#1280 live dogfood). The popover
      // belongs to the active leaf's toolbar, so only the active leaf's
      // terminal may open it. A keydown from another xterm — the floating pane
      // (Ctrl+`), Deck's brain embed, a background surface — used to toggle
      // Rich Input over the WRONG pane while its own pty got nothing; opting
      // those surfaces out of the pane-side bubble stopped them swallowing the
      // key, but this gate still fired. A keydown from no terminal at all
      // (focus on <body>) is left alone: the binding never required terminal
      // focus.
      const origin = composeOwnerHost(e.target);
      if (origin.ptyId !== null && (!origin.owns || origin.ptyId !== activePtyId)) return;
      e.preventDefault();
      state.setToolbarPopover(state.toolbarPopover === 'rich' ? null : 'rich');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}

import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Workspace } from '../../shared/types';
import { findLeaf } from '../../shared/paneUtils';
import { terminalRegistry, onTerminalRegistered } from './useTerminal';

/**
 * Resolve which PTY's xterm should hold keyboard focus for the current store
 * state: the active surface of the active pane in the active workspace.
 *
 * Returns `null` when nothing resolves — no active workspace, the active pane
 * isn't a leaf, the surface has no PTY yet, or the surface is a non-terminal
 * (browser/editor) that has no xterm to focus. Callers treat `null` as "leave
 * DOM focus where it is".
 *
 * Pure (no DOM / registry access) so the resolution logic is unit-testable in
 * the repo's node (no-JSDOM) vitest environment without xterm or a live store.
 */
export function resolveActivePanePtyId(
  state: { workspaces: Workspace[]; activeWorkspaceId: string },
): string | null {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return null;
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface) return null;
  // Empty ptyId means the surface is mid-create / cleared by reconcile — no
  // xterm is registered for it yet, so there is nothing to focus.
  if (!surface.ptyId) return null;
  // Browser / editor surfaces have no xterm. The registry lookup below would
  // miss them anyway, but skipping here keeps the retry loop from spinning
  // 10 frames every time the user lands on a browser pane.
  if (surface.surfaceType === 'browser' || surface.surfaceType === 'editor' || surface.surfaceType === 'diff') return null;
  return surface.ptyId;
}

/**
 * Compact signature of the current focus target: active workspace + pane +
 * surface + its pty, PLUS the multiview set. The focus effect keys on this so it
 * re-runs whenever any of them changes. Pure (no DOM) for unit testing.
 *
 * ptyId matters for boot reconcile: a restored surface's stale ptyId is cleared
 * then re-created (same ws/pane/surface, new pty), and focus must follow it.
 *
 * The active-workspace-in-grid flag matters because toggling multiview swaps
 * AppLayout's render branch (single view vs grid), which REMOUNTS the pane
 * subtree and its terminals with the SAME ws/pane/surface/pty. Without a term
 * that captures that flip the effect would not re-run, driveFocusToTerminal's
 * one-shot subscription would stay disarmed, and the freshly remounted xterm
 * would never get DOM focus (typing goes nowhere until a click). We key on the
 * boolean, not the raw multiviewIds set, so edits to OTHER workspaces do not
 * needlessly re-run the effect (input-dead investigation, sibling to #318).
 *
 * The space separator can't appear in an id, so distinct targets never collide.
 */
export function computeFocusKey(
  state: { workspaces: Workspace[]; activeWorkspaceId: string; multiviewIds: string[] },
): string {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return '';
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  const surface = leaf?.surfaces.find((x) => x.id === leaf.activeSurfaceId);
  // Only whether the ACTIVE workspace renders in the multiview grid (vs single
  // view) — that boolean is what flips its render branch and remounts its
  // terminal (AppLayout gate: multiviewIds.length >= 2 && includes(active)).
  // Keying on the full multiviewIds set would also re-run the effect for
  // unrelated edits (adding/removing OTHER workspaces) and needlessly re-steal
  // focus to the terminal.
  const activeInGrid = state.multiviewIds.length >= 2 && state.multiviewIds.includes(state.activeWorkspaceId);
  return `${state.activeWorkspaceId} ${ws.activePaneId} ${leaf?.activeSurfaceId ?? ''} ${surface?.ptyId ?? ''} ${activeInGrid ? 'grid' : 'single'}`;
}

export interface FocusDriverDeps {
  getTerminal: (ptyId: string) => { focus(): void } | undefined;
  /** Subscribe to terminal registrations; returns an unsubscribe fn. */
  onRegistered: (cb: (ptyId: string) => void) => () => void;
  raf: (cb: () => void) => number;
  caf: (handle: number) => void;
  maxTries?: number;
}

/**
 * Pull DOM focus onto `ptyId`'s xterm, tolerating late registration.
 *
 * Fast path: the terminal is usually registered already (pane/surface
 * switches between live terminals) — focus immediately, or within a few
 * animation frames for a freshly split pane whose PTY is still being created.
 *
 * Slow path (the v3.0.0 field bug): a session-restore terminal registers only
 * AFTER its async scrollback load, far beyond any frame-bounded retry — and
 * the focus target never changes again at boot, so the old give-up-after-10-
 * frames behavior left DOM focus on <body> (typing went nowhere until a
 * pane/workspace switch). The registration subscription closes that hole.
 *
 * The subscription is one-shot and disarms as soon as the terminal has been
 * seen registered (either path), so a LATER re-registration of the same pty
 * (font-change remount, multiview exit) can't yank focus away from wherever
 * the user has put it since.
 *
 * Returns a cleanup fn; callers must invoke it when the target changes.
 */
export function driveFocusToTerminal(ptyId: string, deps: FocusDriverDeps): () => void {
  const maxTries = deps.maxTries ?? 10;
  let raf = 0;
  let tries = 0;
  let unsubscribe: (() => void) | null = null;

  const disarm = (): void => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const apply = (): void => {
    raf = 0;
    const term = deps.getTerminal(ptyId);
    if (term) {
      disarm();
      term.focus();
      return;
    }
    if (tries++ < maxTries) raf = deps.raf(apply);
    // Past maxTries the registration subscription below stays armed — that
    // is the boot-restore path.
  };

  // Subscribe BEFORE the first poll so a registration can't slip between.
  unsubscribe = deps.onRegistered((registered) => {
    if (registered !== ptyId) return;
    disarm();
    deps.getTerminal(ptyId)?.focus();
  });
  apply();

  return () => {
    if (raf) deps.caf(raf);
    disarm();
  };
}

/**
 * Is DOM focus "orphaned" — sitting on <body> or nowhere — rather than on a
 * real interactive element?
 *
 * This is the load-bearing guard for the focus self-heal below. The heal may
 * ONLY reclaim abandoned focus, never STEAL focus the user has placed: when a
 * palette input, the agent-toolbar textarea, another pane's xterm, or a browser
 * webview legitimately holds focus, `document.activeElement` is THAT element
 * (not body), so this returns false and the heal stands down. It is exactly
 * what lets the heal coexist with `driveFocusToTerminal`'s deliberately
 * one-shot disarm (see its doc): that disarm stops focus being re-grabbed on a
 * remount; this only ever fires when nobody owns focus at all.
 */
export function isFocusOrphaned(active: Element | null, body: Element | null): boolean {
  return active === null || active === body;
}

export interface FocusReassertDeps {
  /** The ptyId that SHOULD hold focus, or null (browser/editor/empty/no-ws). */
  resolveTarget: () => string | null;
  getActiveElement: () => Element | null;
  getBody: () => Element | null;
  /** Pull DOM focus onto a terminal's xterm by ptyId. Returns true ONLY when
   *  the terminal exists, is actually focusable (visible in layout), AND focus
   *  landed on a real element. Returns false for a missing / invisible / still-
   *  mounting terminal — focusing such a terminal is a silent no-op that leaves
   *  DOM focus on <body>, and treating that as a heal is exactly what let the
   *  reclaim↔orphan thrash spin (focusout → reclaim → focus() bounces back to
   *  body → focusout → ...), the intermittent "typing dead until I make a new
   *  pane" bug. */
  focusTerminal: (ptyId: string) => boolean;
  /** Defer one frame so we read activeElement AFTER the focus change settles. */
  defer: (cb: () => void) => void;
  /** Instrumentation: the element that just lost focus (focusout target), or
   *  null when the signal was not a focusout (keydown / window-focus). Logged
   *  on a real heal so the NEXT dead-input episode NAMES what dropped focus to
   *  <body> instead of leaving the orphaning source a guess. */
  describeCulprit?: () => string | null;
  /** Instrumentation: called with the ptyId (and culprit, if known) whenever a
   *  heal actually fires. */
  onHeal?: (ptyId: string, culprit: string | null) => void;
}

/**
 * Reclaim DOM focus onto the active terminal when it has been orphaned to
 * <body>. This closes the structural hole behind the field bug "typing dies in
 * the Claude pane until I toggle multiview": every transient overlay (Ctrl+F
 * search bar, Ctrl+K palette, notification panel, agent-toolbar RichInput)
 * focuses its OWN field and, on dismiss, UNMOUNTS — dropping DOM focus to
 * <body>. Those overlays toggle via store flags that are NOT part of
 * `useActivePaneFocus`'s focusKey, so the one-shot driver never re-runs and the
 * terminal stays deaf. A multiview toggle "recovers" only because it remounts
 * the whole workspace subtree and re-runs focus resolution from scratch.
 *
 * Two-stage check: a synchronous fast-bail keeps the per-keystroke path cheap
 * (when a real element holds focus we never even touch the defer), and a
 * deferred re-check absorbs the transient `<body>` window during a LEGIT focus
 * move (terminal → palette input) so we don't yank focus back out from under
 * the user mid-transition.
 */
export function reassertFocusIfOrphaned(deps: FocusReassertDeps): void {
  if (!isFocusOrphaned(deps.getActiveElement(), deps.getBody())) return;
  deps.defer(() => {
    if (!isFocusOrphaned(deps.getActiveElement(), deps.getBody())) return;
    const ptyId = deps.resolveTarget();
    if (!ptyId) return;
    // Only count it as a heal if focus actually LANDED. A no-op focus() on an
    // invisible / mid-remount terminal leaves DOM focus on <body>; healing
    // "successfully" onto it would re-fire on the next focusout and thrash.
    const healed = deps.focusTerminal(ptyId);
    if (!healed) return;
    deps.onHeal?.(ptyId, deps.describeCulprit?.() ?? null);
  });
}

/**
 * Keyboard pane/surface navigation moves the *visual* active marker (the red
 * pane border, driven by `ws.activePaneId` in the store) but does NOT move DOM
 * focus. xterm routes keystrokes from whichever textarea currently holds DOM
 * focus (`useTerminal`'s `terminal.onData` → `pty.write`), so after a
 * keyboard-driven switch the visual focus and the input target diverge: typing
 * still lands in the previously focused pane. Mouse clicks don't hit this — the
 * click lands on the target xterm's DOM and the browser focuses it for free.
 *
 * This hook closes the gap centrally. It watches the resolved active terminal
 * (workspace + pane + surface + pty) and pulls DOM focus onto that xterm
 * whenever the target changes, covering every state-only switch path in one
 * place: `focusPaneDirection` (Ctrl+B arrows / Alt+Ctrl arrows), `cyclePane`
 * (Ctrl+Tab), surface-tab switches (`setActiveSurface`), the RPC `pane.focus`
 * bridge, and the boot-time session restore (late xterm registration).
 */
export function useActivePaneFocus(): void {
  // Re-run the focus effect whenever the focus target OR the multiview set
  // changes. Logic + rationale (why multiviewIds is in the key) live in
  // computeFocusKey.
  const focusKey = useStore(computeFocusKey);

  useEffect(() => {
    const ptyId = resolveActivePanePtyId(useStore.getState());
    if (!ptyId) return;
    return driveFocusToTerminal(ptyId, {
      getTerminal: (id) => terminalRegistry.get(id),
      onRegistered: onTerminalRegistered,
      raf: (cb) => requestAnimationFrame(cb),
      caf: (handle) => cancelAnimationFrame(handle),
    });
  }, [focusKey]);

  // Self-heal: reclaim focus when an overlay (search bar / command palette /
  // notification panel / agent-toolbar RichInput) closes and drops DOM focus to
  // <body>. The primary effect above only fires when the focus TARGET changes;
  // these triggers cover the "target unchanged, focus abandoned" hole that left
  // the terminal deaf until a multiview remount. Mounted once (this hook lives
  // at AppLayout) and never re-armed per target, so it is independent of
  // focusKey. The `isFocusOrphaned` guard inside means a real element holding
  // focus (palette, toolbar, another pane, browser webview) is never disturbed.
  useEffect(() => {
    // Track deferred frames so cleanup fully disarms the heal: a focusout /
    // keydown landing right before unmount could otherwise leave a queued rAF
    // that refocuses a terminal from a torn-down effect instance.
    const pending = new Set<number>();
    const onSignal = (ev?: Event): void => reassertFocusIfOrphaned({
      resolveTarget: () => resolveActivePanePtyId(useStore.getState()),
      getActiveElement: () => document.activeElement,
      getBody: () => document.body,
      focusTerminal: (id) => {
        const term = terminalRegistry.get(id);
        if (!term) return false;
        // An invisible / mid-remount terminal (display:none ancestor during a
        // workspace-switch or hidden-pane window) can't hold focus. offsetParent
        // is null iff the element or an ancestor is display:none — exactly that
        // case. Skip it so we don't focus() into the void and spin the
        // reclaim↔orphan thrash loop (see focusTerminal doc on FocusReassertDeps).
        const el = (term as unknown as { element?: HTMLElement }).element;
        if (el && el.offsetParent === null) return false;
        term.focus();
        // Confirm focus actually landed on a real element. If the terminal was
        // not focusable after all, activeElement is still <body> and this is not
        // a real heal — report failure so the caller neither loops nor logs it.
        return !isFocusOrphaned(document.activeElement, document.body);
      },
      defer: (cb) => {
        const handle = requestAnimationFrame(() => { pending.delete(handle); cb(); });
        pending.add(handle);
      },
      // For a focusout, the event target is the element that just RELINQUISHED
      // focus to <body> — i.e. the orphaning culprit. Snapshot it here (the
      // event is stale by the deferred frame). keydown / window-focus carry no
      // meaningful culprit.
      describeCulprit: () => {
        const t = ev && ev.type === 'focusout' ? (ev.target as Element | null) : null;
        if (!t || !(t instanceof Element)) return null;
        const cls = typeof t.className === 'string' && t.className ? `.${t.className.trim().split(/\s+/).join('.')}` : '';
        const id = t.id ? `#${t.id}` : '';
        return `${t.tagName.toLowerCase()}${id}${cls}`;
      },
      onHeal: (id, culprit) => console.debug(
        `[useActivePaneFocus] reclaimed orphaned focus → pty=${id}` +
        (culprit ? ` (lost-from=${culprit})` : ''),
      ),
    });
    // window 'focus': OS focus returns (alt-tab back) onto <body>.
    // 'focusout': an element (overlay input) just relinquished / was unmounted;
    //   bubbles to document, unlike 'blur'.
    // 'keydown': safety net — a key reached <body> because nothing is focused
    //   (the literal dead-input moment); re-assert so the NEXT key lands.
    window.addEventListener('focus', onSignal);
    document.addEventListener('focusout', onSignal);
    document.addEventListener('keydown', onSignal);
    return () => {
      window.removeEventListener('focus', onSignal);
      document.removeEventListener('focusout', onSignal);
      document.removeEventListener('keydown', onSignal);
      for (const handle of pending) cancelAnimationFrame(handle);
      pending.clear();
    };
  }, []);
}

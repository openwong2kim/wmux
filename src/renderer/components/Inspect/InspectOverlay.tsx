// S4 — Color inspect-mode overlay (point-and-style).
//
// Renders only while `inspectModeActive`. A full-screen transparent capture
// layer intercepts every mouse event so nothing leaks to the terminal (PTY
// isolation, D-focus). On entry the overlay blurs the focused element (the
// active pane's textarea) and takes focus itself. Hovering reverse-maps the
// element under the cursor to its editable token via the F1 foundation helpers
// and outlines every region that shares that token; clicking opens the matching
// editor (UI token, multi-role menu, derived→source routing, terminal bg/fg
// slot, or a non-silent "not customizable" hint).
//
// Everything coordinate/rAF/focus-dependent lives here (jsdom can't exercise it
// → GUI dogfood). The branchy decision logic is extracted to inspectActions.ts
// and unit-tested. Overlay chrome uses FIXED high-contrast colors, never live
// var(--*) tokens, so it stays legible even if the user breaks their palette.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  findTokenForElement,
  regionsForToken,
  type UIThemeTokenKey,
  type TokenRole,
} from '../../themes';
import {
  resolveClickAction,
  isTerminalElement,
  isOverlayElement,
  firstNonOverlayElement,
  overlayShouldCapture,
  type RoleOption,
  type InspectAction,
} from './inspectActions';

// Fixed high-contrast palette for overlay chrome (D: never use live tokens).
const C = {
  outline: '#22D3EE',       // cyan — region highlight
  outlineSoft: 'rgba(34,211,238,0.18)',
  chipBg: '#0B1220',
  chipText: '#F8FAFC',
  chipBorder: '#22D3EE',
  menuBg: '#0B1220',
  menuText: '#F8FAFC',
  menuHover: '#1E293B',
  menuBorder: '#334155',
  hintBg: '#3F1D1D',
  hintText: '#FECACA',
  hintBorder: '#F87171',
} as const;

interface HighlightState {
  token: UIThemeTokenKey;
  role: TokenRole;
  /** Representative role used for the chip / count. */
  count: number;
  rects: DOMRect[];
  chip: { x: number; y: number };
}

interface RoleMenuState {
  x: number;
  y: number;
  options: RoleOption[];
}

interface TerminalMenuState {
  x: number;
  y: number;
}

interface HintState {
  x: number;
  y: number;
}

/** Marked-region descriptor for the roving-tabindex proxies (keyboard path). */
interface ProxyTarget {
  el: Element;
  token: UIThemeTokenKey;
  role: TokenRole;
}

const REGION_SELECTOR =
  '[data-token-bg],[data-token-text],[data-token-border],[data-token-accent]';

export default function InspectOverlay(): React.ReactElement | null {
  const active = useStore((s) => s.inspectModeActive);
  const exitInspect = useStore((s) => s.exitInspect);
  const setInspectTarget = useStore((s) => s.setInspectTarget);
  const setInspectXtermTarget = useStore((s) => s.setInspectXtermTarget);
  // A pending target (UI token or xterm slot) means the Settings picker is open
  // underneath; the overlay must yield its capture so clicks reach the picker
  // (integration glue). Recomputed via the pure overlayShouldCapture helper.
  const inspectTargetToken = useStore((s) => s.inspectTargetToken);
  const inspectXtermTarget = useStore((s) => s.inspectXtermTarget);
  const t = useT();

  const hasTarget = inspectTargetToken !== null || inspectXtermTarget !== null;
  const capturing = overlayShouldCapture(active, hasTarget);

  const rootRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  const [highlight, setHighlight] = useState<HighlightState | null>(null);
  const [roleMenu, setRoleMenu] = useState<RoleMenuState | null>(null);
  const [terminalMenu, setTerminalMenu] = useState<TerminalMenuState | null>(null);
  const [hint, setHint] = useState<HintState | null>(null);
  const [proxies, setProxies] = useState<ProxyTarget[]>([]);
  const [focusedProxy, setFocusedProxy] = useState(0);

  // Last representative token under the cursor — pointermove skips recompute
  // when unchanged (D-perf cache). Lives in a ref so the listener stays stable.
  const lastTokenRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  // ── Commit a token target (used by click + Enter). Stay in inspect: the
  //    overlay yields capture (overlayShouldCapture → false) and the Settings
  //    modal re-expands to edit this token. Calling exitInspect here would
  //    immediately null the target (resetInspectState) and tear the overlay
  //    down, so the editor would never see which region was clicked — the user
  //    leaves inspect when they hit Done/ESC, not on every pick.
  const pickToken = useCallback(
    (token: UIThemeTokenKey, role: TokenRole) => {
      setInspectTarget(token, role);
    },
    [setInspectTarget],
  );

  const pickTerminal = useCallback(
    (slot: 'background' | 'foreground') => {
      setInspectXtermTarget(slot);
    },
    [setInspectXtermTarget],
  );

  // ── Highlight all regions for the current token, syncing rects every frame so
  //    scroll/resize never leaves a stale outline (D-perf rAF rect sync).
  const syncHighlight = useCallback((token: UIThemeTokenKey, role: TokenRole) => {
    const els = regionsForToken(token, role);
    const rects = els.map((el) => el.getBoundingClientRect());
    // Anchor the chip to the first region's top-left.
    const first = rects[0];
    setHighlight({
      token,
      role,
      count: els.length,
      rects,
      chip: first ? { x: first.left, y: Math.max(first.top - 28, 4) } : { x: 8, y: 8 },
    });
  }, []);

  // ── Continuous rAF loop: re-sync the active highlight's rects so they track
  //    scroll/resize/layout without per-event listeners (D-perf).
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const token = lastTokenRef.current;
      if (token && highlight) {
        const els = regionsForToken(highlight.token, highlight.role);
        const rects = els.map((el) => el.getBoundingClientRect());
        const first = rects[0];
        setHighlight((prev) =>
          prev
            ? {
                ...prev,
                rects,
                count: els.length,
                chip: first ? { x: first.left, y: Math.max(first.top - 28, 4) } : prev.chip,
              }
            : prev,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // highlight.token/role drive the loop; re-arm when they change. (The
    // exhaustive-deps lint rule isn't registered in this repo's config.)
  }, [active, highlight?.token, highlight?.role]);

  // ── Entry: blur the focused element (active pane textarea) + take focus.
  //    Also snapshot the marked regions for the keyboard proxy ring (D-focus).
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (previouslyFocused && typeof previouslyFocused.blur === 'function') {
      previouslyFocused.blur();
    }
    rootRef.current?.focus();

    const collected: ProxyTarget[] = [];
    document.querySelectorAll(REGION_SELECTOR).forEach((el) => {
      const resolved = findTokenForElement(el);
      if (!resolved) return;
      const { token, role } = resolved.representative;
      const derived = resolved.derivedNote;
      collected.push({ el, token: derived ?? token, role });
    });
    setProxies(collected);
    setFocusedProxy(0);

    return () => {
      lastTokenRef.current = null;
    };
  }, [active]);

  // ── Pointer move on the capture layer → reverse-map → highlight (D-hittest,
  //    D-perf). Skip recompute when the representative token is unchanged.
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Drop any open menu/hint as soon as the cursor moves again.
      if (roleMenu || terminalMenu || hint) {
        setRoleMenu(null);
        setTerminalMenu(null);
        setHint(null);
      }
      // Exclude ALL overlay chrome (capture layer, chips, menus, banner — any
      // pointer-events:auto bit that can sit atop the cursor) before judging the
      // hit, so a chrome element never wins the terminal test or the token
      // reverse-map. Same filter the click path uses (kept identical on purpose).
      const stack = document
        .elementsFromPoint(e.clientX, e.clientY)
        .filter((el) => !isOverlayElement(el, rootRef.current));
      const target = firstNonOverlayElement(stack, rootRef.current);
      if (!target) return;

      if (isTerminalElement(stack)) {
        // Terminal area: show a single soft hint outline, no token chip.
        if (lastTokenRef.current !== '__terminal__') {
          lastTokenRef.current = '__terminal__';
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => setHighlight(null));
        }
        return;
      }

      const resolved = findTokenForElement(target);
      if (!resolved) {
        if (lastTokenRef.current !== null) {
          lastTokenRef.current = null;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => setHighlight(null));
        }
        return;
      }

      const repToken = resolved.derivedNote ?? resolved.representative.token;
      const repRole = resolved.representative.role;
      if (lastTokenRef.current === repToken) return; // D-perf cache hit.
      lastTokenRef.current = repToken;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => syncHighlight(repToken, repRole));
    },
    [roleMenu, terminalMenu, hint, syncHighlight],
  );

  // ── Click on the capture layer → resolve action → dispatch.
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Exclude ALL overlay chrome before judging the hit — identical to the
      // pointer-move filter — so a menu/banner/chip on top of the cursor can't
      // be mistaken for the terminal area or reverse-mapped to a token.
      const stack = document
        .elementsFromPoint(e.clientX, e.clientY)
        .filter((el) => !isOverlayElement(el, rootRef.current));
      const target = firstNonOverlayElement(stack, rootRef.current);
      const isTerminal = isTerminalElement(stack);
      const resolved = target ? findTokenForElement(target) : null;
      const action: InspectAction = resolveClickAction(resolved, isTerminal);

      switch (action.kind) {
        case 'terminal':
          setTerminalMenu({ x: e.clientX, y: e.clientY });
          setRoleMenu(null);
          setHint(null);
          break;
        case 'pick':
          pickToken(action.token, action.role);
          break;
        case 'menu':
          setRoleMenu({ x: e.clientX, y: e.clientY, options: action.options });
          setTerminalMenu(null);
          setHint(null);
          break;
        case 'hint':
          setHint({ x: e.clientX, y: e.clientY });
          setRoleMenu(null);
          setTerminalMenu(null);
          break;
      }
    },
    [pickToken],
  );

  // ── Keyboard: ESC exits; Tab cycles the proxy ring; Enter selects (D-focus,
  //    D-esc). The overlay owns the roving tabindex — production tabindex is
  //    never touched.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitInspect();
        return;
      }
      if (e.key === 'Tab' && proxies.length > 0) {
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        const next = (focusedProxy + dir + proxies.length) % proxies.length;
        setFocusedProxy(next);
        const p = proxies[next];
        const rect = p.el.getBoundingClientRect();
        syncHighlight(p.token, p.role);
        lastTokenRef.current = p.token;
        // Move the chip near the focused proxy for SR/sighted parity.
        setHighlight((prev) => (prev ? { ...prev, chip: { x: rect.left, y: Math.max(rect.top - 28, 4) } } : prev));
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && proxies.length > 0) {
        e.preventDefault();
        const p = proxies[focusedProxy];
        if (p) pickToken(p.token, p.role);
      }
    },
    [exitInspect, proxies, focusedProxy, pickToken, syncHighlight],
  );

  // ── Cleanup: cancel any pending rAF when leaving inspect / unmounting.
  useEffect(() => {
    if (active) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTokenRef.current = null;
    setHighlight(null);
    setRoleMenu(null);
    setTerminalMenu(null);
    setHint(null);
  }, [active]);

  if (!active) return null;

  const proxy = proxies[focusedProxy];

  return (
    <div
      ref={rootRef}
      data-inspect-overlay
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[var(--z-inspect)] outline-none"
      // Root is a pass-through container: pointer-events:none so that once a
      // target is set and the capture layer yields (pointer-events:none below),
      // clicks fall through to the Settings picker (z-50) underneath instead of
      // the root swallowing them. Children that need clicks opt back in with
      // pointerEvents:'auto' (capture layer while capturing, role/terminal menus,
      // banner/Done). crosshair lives on the capture layer, not here.
      style={{ pointerEvents: 'none' }}
      aria-label={t('settings.inspect.banner')}
      role="application"
    >
      {/* Transparent capture layer — owns every mouse event so the terminal
          never receives them (PTY isolation). While a target is being edited
          the layer yields (pointer-events:none) so clicks fall through to the
          Settings picker that re-expanded underneath (integration glue). */}
      <div
        ref={captureRef}
        data-inspect-overlay
        className="absolute inset-0"
        style={{ pointerEvents: capturing ? 'auto' : 'none', cursor: 'crosshair' }}
        onPointerMove={onPointerMove}
        onClick={onClick}
      />

      {/* Hover affordances (highlights, chip, menus, hint, proxy) are paused
          while a target is being edited — capture is yielded so they'd be stale
          and would obscure the Settings picker. The banner stays so the user
          can always exit. */}
      {/* Region highlights — outline every area painted by the hovered token. */}
      {capturing && highlight?.rects.map((r, i) => (
        <div
          key={i}
          data-inspect-overlay
          className="absolute"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            border: `2px solid ${C.outline}`,
            backgroundColor: reducedMotion.current ? 'transparent' : C.outlineSoft,
            boxShadow: `0 0 0 1px ${C.chipBg}`,
            pointerEvents: 'none',
            borderRadius: 4,
            transition: reducedMotion.current ? undefined : 'opacity 120ms ease',
          }}
        />
      ))}

      {/* "Applies to N marked areas" chip. */}
      {capturing && highlight && (
        <div
          data-inspect-overlay
          className="absolute font-mono text-xs px-2 py-1 rounded-md"
          style={{
            left: highlight.chip.x,
            top: highlight.chip.y,
            backgroundColor: C.chipBg,
            color: C.chipText,
            border: `1px solid ${C.chipBorder}`,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {t('settings.inspect.appliesTo', { count: highlight.count })}
        </div>
      )}

      {/* Multi-role disambiguation menu (fill / text / border / accent). */}
      {capturing && roleMenu && (
        <div
          data-inspect-overlay
          className="absolute font-mono text-xs rounded-md overflow-hidden"
          style={{
            left: roleMenu.x,
            top: roleMenu.y,
            backgroundColor: C.menuBg,
            border: `1px solid ${C.menuBorder}`,
            pointerEvents: 'auto',
            minWidth: 120,
          }}
          role="menu"
        >
          {roleMenu.options.map((opt) => (
            <button
              key={opt.role}
              type="button"
              role="menuitem"
              className="block w-full text-left px-3 py-1.5"
              style={{ color: C.menuText, backgroundColor: 'transparent' }}
              onMouseEnter={(ev) => {
                (ev.currentTarget as HTMLElement).style.backgroundColor = C.menuHover;
              }}
              onMouseLeave={(ev) => {
                (ev.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
              }}
              onClick={(ev) => {
                ev.stopPropagation();
                pickToken(opt.token, opt.role);
              }}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      )}

      {/* Terminal area menu — background / foreground slot (D-terminal v1). */}
      {capturing && terminalMenu && (
        <div
          data-inspect-overlay
          className="absolute font-mono text-xs rounded-md overflow-hidden"
          style={{
            left: terminalMenu.x,
            top: terminalMenu.y,
            backgroundColor: C.menuBg,
            border: `1px solid ${C.menuBorder}`,
            pointerEvents: 'auto',
            minWidth: 160,
          }}
          role="menu"
        >
          {(['background', 'foreground'] as const).map((slot) => (
            <button
              key={slot}
              type="button"
              role="menuitem"
              className="block w-full text-left px-3 py-1.5"
              style={{ color: C.menuText, backgroundColor: 'transparent' }}
              onMouseEnter={(ev) => {
                (ev.currentTarget as HTMLElement).style.backgroundColor = C.menuHover;
              }}
              onMouseLeave={(ev) => {
                (ev.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
              }}
              onClick={(ev) => {
                ev.stopPropagation();
                pickTerminal(slot);
              }}
            >
              {slot === 'background'
                ? t('settings.inspect.terminalBg')
                : t('settings.inspect.terminalFg')}
            </button>
          ))}
        </div>
      )}

      {/* Non-silent "not customizable yet" hint (D: no silent no-op). */}
      {capturing && hint && (
        <div
          data-inspect-overlay
          className="absolute font-mono text-xs px-2 py-1 rounded-md"
          style={{
            left: hint.x,
            top: hint.y,
            backgroundColor: C.hintBg,
            color: C.hintText,
            border: `1px solid ${C.hintBorder}`,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
          role="status"
        >
          {t('settings.inspect.notCustomizable')}
        </div>
      )}

      {/* Roving-tabindex proxy: one focusable button representing the currently
          focused marked region. The overlay owns it, so production tabindex is
          untouched. Visually hidden but reachable by SR + Tab/Enter. */}
      {capturing && proxy && (
        <button
          data-inspect-overlay
          type="button"
          aria-label={t('settings.inspect.proxyLabel', { token: proxy.token, role: proxy.role })}
          className="absolute"
          style={{
            left: -9999,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
          tabIndex={-1}
        />
      )}

      {/* Banner — fixed-contrast instruction + Done button (Esc parity). */}
      <div
        data-inspect-overlay
        className="absolute left-1/2 bottom-6 -translate-x-1/2 flex items-center gap-3 font-mono text-xs px-4 py-2 rounded-[7px]"
        style={{
          backgroundColor: C.chipBg,
          color: C.chipText,
          border: `1px solid ${C.chipBorder}`,
          pointerEvents: 'auto',
        }}
      >
        <span>{t('settings.inspect.banner')}</span>
        <button
          type="button"
          className="px-2 py-0.5 rounded-md"
          style={{ backgroundColor: C.outline, color: C.chipBg, fontWeight: 600 }}
          onClick={(ev) => {
            ev.stopPropagation();
            exitInspect();
          }}
        >
          {t('settings.inspect.done')}
        </button>
      </div>
    </div>
  );
}

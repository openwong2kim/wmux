import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared keyboard and focus layer for modal surfaces (ui/Dialog and the
 * onboarding tour card).
 *
 * One keydown listener, capture phase on window, installed when this module
 * is first imported — which is at app start, before any component effect —
 * so it runs ahead of every capture listener a component adds later (the
 * Settings panel's Escape handler among them). For the top-most open layer it:
 * - handles Escape (unless an IME composition is active) and stops the event
 *   with stopImmediatePropagation, so one Escape closes exactly one surface;
 * - wraps Tab / Shift+Tab at the layer's edges, but only while focus is
 *   already inside it — focus deliberately handed to something else (the
 *   sample task hands it to the new terminal) keeps its own Tab.
 *
 * Each layer also puts focus back inside when it is orphaned on <body> (the
 * focused button was removed by a re-render), before the app's focus heal can
 * give it to a background terminal, and returns focus to its opener when it
 * closes.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',');

type VisibilityCheck = (opts: Record<string, boolean>) => boolean;

/** Tabbable descendants in DOM order: no negative tabindex, nothing inside a
 *  hidden / aria-hidden / inert subtree, nothing CSS-hidden where the engine
 *  can tell. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    const check = (el as HTMLElement & { checkVisibility?: VisibilityCheck }).checkVisibility;
    if (typeof check === 'function') {
      return check.call(el, { visibilityProperty: true, checkVisibilityCSS: true });
    }
    return true;
  });
}

interface Layer {
  seq: number;
  el: HTMLElement | null;
  onEscape: (() => void) | undefined;
}

const layers: Layer[] = [];
let nextSeq = 0;

/**
 * The layer that owns the keyboard: among open layers that do not contain
 * another open layer (a nested dialog beats the one it renders inside, even
 * though the child's effects registered first), the most recently opened.
 */
export function topLayer(): Layer | undefined {
  let top: Layer | undefined;
  for (const layer of layers) {
    const containsOther = layers.some(
      (other) => other !== layer && !!layer.el && !!other.el && layer.el.contains(other.el),
    );
    if (containsOther) continue;
    if (!top || layer.seq > top.seq) top = layer;
  }
  return top;
}

function isOrphaned(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

function healFocus(layer: Layer): void {
  if (topLayer() !== layer || !layer.el || !isOrphaned()) return;
  (focusableWithin(layer.el)[0] ?? layer.el).focus();
}

function onKeyDown(e: KeyboardEvent): void {
  const top = topLayer();
  if (!top) return;

  if (e.key === 'Escape') {
    // Mid-IME Escape cancels the composition; it is not a close request.
    if (e.isComposing || e.keyCode === 229) return;
    // A modal surface never lets Escape through to what is underneath, even
    // when it ignores Escape itself.
    e.preventDefault();
    e.stopImmediatePropagation();
    top.onEscape?.();
    return;
  }

  if (e.key !== 'Tab' || !top.el) return;
  const active = document.activeElement;
  if (!(active instanceof Node) || !top.el.contains(active)) return;
  const items = focusableWithin(top.el);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (active === first || active === top.el)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// Install once per window; a hot-reloaded copy of this module replaces the
// previous listener instead of stacking a second one.
const LISTENER_KEY = '__wmuxModalLayerKeydown';
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, ((e: KeyboardEvent) => void) | undefined>;
  const previous = w[LISTENER_KEY];
  if (previous) window.removeEventListener('keydown', previous, true);
  w[LISTENER_KEY] = onKeyDown;
  window.addEventListener('keydown', onKeyDown, true);
}

export interface ModalLayerOptions {
  /** Called on Escape while this layer is top-most. Omit to ignore Escape. */
  onEscape?: () => void;
}

/**
 * Registers a modal layer for the lifetime of the calling component. Attach
 * the returned callback ref to the layer's outermost focus container.
 */
export function useModalLayer({ onEscape }: ModalLayerOptions): (el: HTMLElement | null) => void {
  // The opener is read during the first render, before any child can take
  // focus in its own mount (autoFocus runs before parent effects).
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const layerRef = useRef<Layer | null>(null);
  if (!layerRef.current) layerRef.current = { seq: nextSeq++, el: null, onEscape };
  layerRef.current.onEscape = onEscape;

  const observerRef = useRef<MutationObserver | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const layer = layerRef.current as Layer;
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i !== -1) layers.splice(i, 1);
      const active = document.activeElement;
      const focusWasOurs = isOrphaned() || (!!layer.el && active instanceof Node && layer.el.contains(active));
      // Focus that moved on purpose (into a terminal) stays where it went.
      if (focusWasOurs && opener && opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      detachRef.current?.();
    },
    [],
  );

  return useCallback((el: HTMLElement | null) => {
    const layer = layerRef.current as Layer;
    if (layer.el === el) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    detachRef.current?.();
    detachRef.current = null;
    layer.el = el;
    if (!el) return;
    // A re-render that removes the focused control drops focus to <body>
    // without any focus event in Chromium; the observer catches that.
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => healFocus(layer));
      observer.observe(el, { childList: true, subtree: true });
      observerRef.current = observer;
    }
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget === null) queueMicrotask(() => healFocus(layer));
    };
    el.addEventListener('focusout', onFocusOut);
    detachRef.current = () => el.removeEventListener('focusout', onFocusOut);
  }, []);
}

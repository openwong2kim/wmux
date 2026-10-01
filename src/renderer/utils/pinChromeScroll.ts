// ─── Keep the window chrome pinned at the top (#1679) ─────────────────────────
//
// `overflow: hidden` blocks user scrolling, not programmatic scrolling. The app
// shell (AppLayout's root column) has a few px of scroll range below its bottom
// edge — the auto-hidden agent toolbar sits translated down out of view — so a
// caret reveal while typing, a focus() or a scrollIntoView() that lands near the
// bottom edge scrolls the whole shell up. The titlebar (the only drag region)
// then slides under the native window controls and nothing ever scrolls it back.
//
// None of the page-level boxes ever scroll on purpose, so any scroll on them is
// undone. Scroll events do not bubble, but they do reach a capturing listener on
// the document. Allowlist only: the viewport, body, #root and elements marked
// `data-pin-scroll` — sidebar lists, terminals and panels are real scrollers.

export const PIN_SCROLL_ATTR = 'data-pin-scroll';

const viewportOf = (doc: Document) => doc.scrollingElement ?? doc.documentElement;

function isPinned(doc: Document, el: Element): boolean {
  return el === viewportOf(doc) || el === doc.body || el.id === 'root' || el.hasAttribute(PIN_SCROLL_ATTR);
}

/** Installs the listener once; returns the uninstaller (used by tests). */
export function installChromeScrollPin(doc: Document = document): () => void {
  const onScroll = (e: Event) => {
    // A viewport scroll is dispatched on the document itself.
    const el = e.target === doc ? viewportOf(doc) : e.target;
    if (!(el instanceof Element) || !isPinned(doc, el)) return;
    if (el.scrollTop !== 0) el.scrollTop = 0;
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener('scroll', onScroll, { capture: true });
}

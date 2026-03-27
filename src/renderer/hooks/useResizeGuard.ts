import { useEffect } from 'react';

/**
 * Global guard: blocks webview pointer capture while any panel separator is
 * being dragged.  Listens for pointerdown on `[data-separator]` elements
 * (react-resizable-panels) and toggles `wmux-resizing` on `document.body`.
 *
 * Call this once from a top-level layout component — it is not per-separator.
 */
export function useResizeGuard(): void {
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // react-resizable-panels adds data-separator to its separator elements
      if (!target.closest('[data-separator]')) return;

      document.body.classList.add('wmux-resizing');
      const cleanup = () => {
        document.body.classList.remove('wmux-resizing');
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };
      window.addEventListener('pointerup', cleanup, { once: true });
      window.addEventListener('pointercancel', cleanup, { once: true });
    }

    // Use capture so we see the event before the library processes it
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.body.classList.remove('wmux-resizing');
    };
  }, []);
}

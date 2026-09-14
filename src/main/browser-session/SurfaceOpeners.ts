/**
 * Which MCP connection opened a browser surface.
 *
 * Two agent panes in one workspace hold two MCP connections. Both used to
 * resolve a call that named no surfaceId to the same "newest surface in the
 * workspace", so the second agent drove the first agent's tab. The fix needs
 * one fact main did not keep: who asked for a surface. The opener key is a
 * random id the calling connection mints once and sends with every open; this
 * is where main remembers it.
 *
 * MEMORY ONLY, deliberately, and this is why it is a registry of its own
 * rather than a field on the records each backend keeps:
 *
 *  - ChromeLauncher persists whole surface records (`chrome-tabs.json`), so an
 *    opener stored there would be written to disk and a restored tab would come
 *    back owned by a connection that no longer exists — permanently undefaultable
 *    for everyone. Ownerless-after-restart is the behavior we want, and keeping
 *    the fact out of the persisted object is what guarantees it.
 *  - The builtin surfaces live in the renderer's pane tree and the live-Chrome
 *    client tracks only its own tab ids, so neither has one place to hold this.
 *
 * It is not a permission boundary. An explicit surfaceId still reaches any
 * surface in the workspace, including another connection's; ownership decides
 * only where an UNSAID target lands, and which surfaces `browser_tabs list`
 * marks as yours.
 */

/** Generous: a working set of browser surfaces, not a history. */
const MAX_ENTRIES = 512;

export class SurfaceOpeners {
  private readonly bySurface = new Map<string, string>();

  /** First writer wins is NOT the rule: an open re-states current ownership. */
  note(surfaceId: string, openerKey: string): void {
    if (!surfaceId || !openerKey) return;
    // Refresh insertion order so the eviction below drops the least recently
    // opened surface rather than an id that is still in daily use.
    this.bySurface.delete(surfaceId);
    this.bySurface.set(surfaceId, openerKey);
    while (this.bySurface.size > MAX_ENTRIES) {
      const oldest = this.bySurface.keys().next().value;
      if (oldest === undefined) break;
      this.bySurface.delete(oldest);
    }
  }

  get(surfaceId: string): string | undefined {
    return this.bySurface.get(surfaceId);
  }

  /** Called when a surface is closed, so a recycled id cannot inherit an owner. */
  forget(surfaceId: string): void {
    this.bySurface.delete(surfaceId);
  }

  /** Test seam. */
  clear(): void {
    this.bySurface.clear();
  }
}

/** One per main process: surface ids are unique across backends. */
export const surfaceOpeners = new SurfaceOpeners();

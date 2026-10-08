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

/**
 * Generous: a working set of browser surfaces, not a history.
 *
 * Eviction is the dangerous direction — a LIVE surface whose entry is dropped
 * reads as unclaimed, and the next connection with no surface of its own
 * adopts it — so the order is refreshed on every read as well as every write.
 * Anything still being used is therefore near the young end, and what falls off
 * is what nothing has asked about for hundreds of surfaces. Closing a surface
 * removes its entry outright, which is what keeps the map near the live count.
 */
const MAX_ENTRIES = 512;

/** Who opened a surface: the connection, and the terminal it ran in. */
interface OpenerRecord {
  openerKey: string;
  /** The opener's `callerPtyId`, when its envelope carried one. */
  ptyId?: string;
}

/**
 * The asking caller, as far as an opener verdict is concerned. `paneBound`
 * says the caller's resolved Chrome profile is its pane's exclusive one.
 */
export interface OpenerCaller {
  openerKey?: string;
  ptyId?: string;
  paneBound?: boolean;
}

/**
 * mine / other / unclaimed (undefined) for one surface.
 *
 * The connection key decides everywhere. Inside a pane-bound profile the
 * TERMINAL decides too: an agent restarted in the same terminal mints a new
 * key, and without this it would see its own tabs as somebody else's and open
 * a fresh one on every run — a periodic loop then grows tabs without bound.
 * A second terminal tab in the same pane is a different PTY, so it still reads
 * the first one's tabs as `other`. Outside a pane-bound profile the PTY is not
 * consulted: a workspace profile is shared by every pane in it, and one PTY
 * match there would hand one pane's tab to whatever else runs in that terminal.
 */
export function openerVerdict(
  record: { openerKey: string; ptyId?: string } | undefined,
  caller: OpenerCaller,
): 'mine' | 'other' | undefined {
  if (!record) return undefined;
  if (caller.openerKey && record.openerKey === caller.openerKey) return 'mine';
  if (caller.paneBound && caller.ptyId && record.ptyId === caller.ptyId) return 'mine';
  return 'other';
}

export class SurfaceOpeners {
  private readonly bySurface = new Map<string, OpenerRecord>();

  /** First writer wins is NOT the rule: an open re-states current ownership. */
  note(surfaceId: string, openerKey: string, ptyId?: string): void {
    if (!surfaceId || !openerKey) return;
    // Refresh insertion order so the eviction below drops the least recently
    // opened surface rather than an id that is still in daily use.
    this.bySurface.delete(surfaceId);
    this.bySurface.set(surfaceId, { openerKey, ...(ptyId && { ptyId }) });
    while (this.bySurface.size > MAX_ENTRIES) {
      const oldest = this.bySurface.keys().next().value;
      if (oldest === undefined) break;
      this.bySurface.delete(oldest);
    }
  }

  get(surfaceId: string): string | undefined {
    return this.touch(surfaceId)?.openerKey;
  }

  /** The verdict for `caller` (see `openerVerdict`). */
  verdict(surfaceId: string, caller: OpenerCaller): 'mine' | 'other' | undefined {
    return openerVerdict(this.touch(surfaceId), caller);
  }

  private touch(surfaceId: string): OpenerRecord | undefined {
    const record = this.bySurface.get(surfaceId);
    if (record === undefined) return undefined;
    // Touch: being asked about is proof this surface is still in play, and an
    // evicted entry would silently make it adoptable by another connection.
    this.bySurface.delete(surfaceId);
    this.bySurface.set(surfaceId, record);
    return record;
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

import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';

/**
 * Ask the renderer (the authority on which panes exist) for every live pane id,
 * stashed panes included. Feeds MetadataStore's label-uniqueness check so a
 * label held by a pane that is gone does not block reuse.
 *
 * Returns undefined when the renderer cannot answer; the store then checks
 * against every labeled entry, which may refuse a stale name but never admits
 * a duplicate.
 */
export async function fetchLivePaneIds(
  getWindow: () => BrowserWindow | null,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const res = (await sendToRenderer(getWindow, 'pane.liveIds', {})) as { paneIds?: unknown } | null;
    if (!res || !Array.isArray(res.paneIds)) return undefined;
    return new Set(res.paneIds.filter((id): id is string => typeof id === 'string'));
  } catch {
    return undefined;
  }
}

import type { Pane } from '../../shared/types';
import { collectPaneTreePtyIds } from '../../shared/paneUtils';
import { destroyPaneTreeRemoteSessions } from './remoteSessionTeardown';

/** Dispose all PTYs inside a pane tree — plus every remote session the tree
 *  owns (#1129), which carries no ptyId and would otherwise survive the pane
 *  that was running it. */
export function disposePanePtys(pane: Pane): void {
  for (const ptyId of collectPaneTreePtyIds(pane)) window.electronAPI.pty.dispose(ptyId);
  destroyPaneTreeRemoteSessions(pane);
}

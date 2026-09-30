/**
 * Browser-build stand-in (vite.web.config.ts) for components/Terminal/Terminal
 * until the terminal adapter lands: a static tab body with the tab's title. It
 * owns no xterm and never calls `pty.*`, so a terminal tab can neither create
 * nor write to a PTY from the browser.
 */
import { useStore } from '../../stores';
import SurfacePlaceholder from '../../components/Pane/SurfacePlaceholder';
import { getLeafPanes } from '../../../shared/paneUtils';

export default function WebTerminalPlaceholder({ isActive = true, visible, surfaceId = '' }: {
  isActive?: boolean;
  visible?: boolean;
  surfaceId?: string;
}) {
  const title = useStore((s) => {
    for (const ws of s.workspaces) {
      for (const leaf of getLeafPanes(ws.rootPane)) {
        const hit = leaf.surfaces.find((x) => x.id === surfaceId);
        if (hit) return hit.title;
      }
    }
    return '';
  });
  return <SurfacePlaceholder title={title} isActive={visible ?? isActive} surfaceId={surfaceId} />;
}

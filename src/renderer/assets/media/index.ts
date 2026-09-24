// Short muted loops for the welcome dialog and the onboarding tour, re-encoded
// from the README clips in docs/readme/*.gif (VP9 WebM, 640px, 10 fps, no
// audio). Each has a still poster for reduced motion and before playback.
import panesSrc from './panes.webm';
import panesPoster from './panes-poster.webp';
import workspacesSrc from './workspaces.webm';
import workspacesPoster from './workspaces-poster.webp';
import fleetSrc from './fleet.webm';
import fleetPoster from './fleet-poster.webp';

export interface MediaClip {
  src: string;
  poster: string;
}

export type MediaClipId = 'panes' | 'workspaces' | 'fleet';

export const MEDIA_CLIPS: Record<MediaClipId, MediaClip> = {
  /** Several agents running side by side in split panes (hero.gif 5.3–8.3s). */
  panes: { src: panesSrc, poster: panesPoster },
  /** The workspace list growing as new workspaces are added (worktrees.gif 1.6–4.2s). */
  workspaces: { src: workspacesSrc, poster: workspacesPoster },
  /** Running and needs-you agents on the Fleet board (fleet.gif 1.8–7.8s). */
  fleet: { src: fleetSrc, poster: fleetPoster },
};

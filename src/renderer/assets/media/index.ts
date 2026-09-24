// Short muted loops for the welcome dialog and the onboarding tour, recorded
// from an isolated wmux instance (VP9 WebM, 640px, 10 fps, no audio). Each
// clip shows exactly what the copy next to it says, and has a still poster
// for reduced motion and for the frame before playback starts.
import splitSrc from './split.webm';
import splitPoster from './split-poster.webp';
import workspacesSrc from './workspaces.webm';
import workspacesPoster from './workspaces-poster.webp';

export interface MediaClip {
  src: string;
  poster: string;
}

export type MediaClipId = 'split' | 'workspaces';

export const MEDIA_CLIPS: Record<MediaClipId, MediaClip> = {
  /** One terminal split right, then down, into a 2x2 grid of shells. */
  split: { src: splitSrc, poster: splitPoster },
  /** The + button opening the layout picker and a new workspace joining the list. */
  workspaces: { src: workspacesSrc, poster: workspacesPoster },
};

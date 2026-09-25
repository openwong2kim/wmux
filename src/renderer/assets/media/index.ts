// Short muted loops for the welcome dialog and the onboarding tour, cut from
// recordings of isolated wmux instances (VP9 WebM, 640x400, 10 fps, no audio).
// Each clip shows what wmux tells you, matching the copy next to it, and has a
// still poster for reduced motion and for the frame before playback starts.
import fleetSrc from './fleet.webm';
import fleetPoster from './fleet-poster.webp';
import fleetBoardSrc from './fleet-board.webm';
import fleetBoardPoster from './fleet-board-poster.webp';
import worktreesSrc from './worktrees.webm';
import worktreesPoster from './worktrees-poster.webp';
import statuslineSrc from './statusline.webm';
import statuslinePoster from './statusline-poster.webp';

export interface MediaClip {
  src: string;
  poster: string;
}

export type MediaClipId = 'fleet' | 'fleet-board' | 'worktrees' | 'statusline';

export const MEDIA_CLIPS: Record<MediaClipId, MediaClip> = {
  /** Fleet with three agents: one finishes its turn and moves up under "Needs you". */
  fleet: { src: fleetSrc, poster: fleetPoster },
  /** The sidebar flags the blocked workspace ("Needs you"), then Fleet lists every agent, blocked first. */
  'fleet-board': { src: fleetBoardSrc, poster: fleetBoardPoster },
  /** One prompt fanned out: each task appears under its workspace on its own wtask/* worktree branch. */
  worktrees: { src: worktreesSrc, poster: worktreesPoster },
  /** Claude Code's line under the input box: model, account, context, then 5h / 7d usage once the first reply lands. */
  statusline: { src: statuslineSrc, poster: statuslinePoster },
};

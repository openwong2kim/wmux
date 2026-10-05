// Short muted loops for the welcome dialog and the onboarding tour, cut from
// recordings of isolated wmux instances (VP9 WebM, 640x400, 10 fps, no audio).
// Each clip shows what wmux tells you, matching the copy next to it, and has a
// still poster for reduced motion and for the frame before playback starts.
import worktreesSrc from './worktrees.webm';
import worktreesPoster from './worktrees-poster.webp';
import statuslineSrc from './statusline.webm';
import statuslinePoster from './statusline-poster.webp';

export interface MediaClip {
  src: string;
  poster: string;
}

export type MediaClipId = 'worktrees' | 'statusline';

export const MEDIA_CLIPS: Record<MediaClipId, MediaClip> = {
  /** One prompt fanned out: each task appears under its workspace on its own wtask/* worktree branch. */
  worktrees: { src: worktreesSrc, poster: worktreesPoster },
  /** Claude Code's line under the input box: model, account, context, then 5h / 7d usage once the first reply lands. */
  statusline: { src: statuslineSrc, poster: statuslinePoster },
};

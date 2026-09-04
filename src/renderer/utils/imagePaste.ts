import { useStore } from '../stores';
import {
  nativeImagePasteSequence,
  quoteImagePathForPty,
  resolveImagePasteStrategy,
} from '../../shared/imagePaste';

/**
 * Paste an image-only clipboard into a PTY (issue #1196).
 *
 * The five paste entry points (⌘V, Ctrl+V, Ctrl+Shift+V, right-click, and the
 * DOM paste event) all reach the clipboard image the same way, so they all call
 * this. Callers check for TEXT first and only fall through to here when the
 * clipboard has no text — a mixed clipboard (browsers put both a paragraph and
 * a screenshot of it on the board) must still paste the text.
 *
 * Two routes, chosen by `imagePasteMode` (see shared/imagePaste.ts):
 *   • native — hand the agent its own image-paste key and let it read the
 *     clipboard itself, producing a real inline attachment. No temp file is
 *     written at all in this case.
 *   • path — the historical route: main saves a PNG temp file and we type its
 *     path, quoted on spaces and wrapped in bracketed paste so the foreground
 *     app sees one paste rather than a stream of keystrokes.
 *
 * Returns true when something was written to the PTY.
 */
export async function pasteClipboardImage(opts: {
  ptyId: string;
  write: (data: string) => void;
  bracketedPasteMode: boolean;
}): Promise<boolean> {
  const { ptyId, write, bracketedPasteMode } = opts;
  if (!(await window.clipboardAPI.hasImage?.())) return false;

  const state = useStore.getState();
  // Known limit of the auto route: a pane's detected agent slug is retained
  // after the agent exits (nothing clears surfaceAgent), so pasting an image
  // into the plain shell left behind by a finished Claude session sends the
  // key to readline, where it is quoted-insert and the image is dropped. The
  // 'path' setting is the escape hatch until agent-exit detection clears the
  // slug.
  const strategy = resolveImagePasteStrategy({
    mode: state.imagePasteMode,
    agentSlug: state.surfaceAgent[ptyId]?.slug,
  });

  // No platform means no way to know WHICH key the agent listens on, and the
  // wrong one is a silent no-op — fall through to the path route instead.
  const platform = window.electronAPI?.platform;
  if (strategy === 'native' && platform) {
    write(nativeImagePasteSequence(platform));
    return true;
  }

  if (!window.clipboardAPI.readImage) return false;
  const imagePath = await window.clipboardAPI.readImage(ptyId);
  if (!imagePath) return false;
  const quoted = quoteImagePathForPty(imagePath);
  write(bracketedPasteMode ? `\x1b[200~${quoted}\x1b[201~` : quoted);
  return true;
}

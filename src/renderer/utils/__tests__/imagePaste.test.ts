// @vitest-environment jsdom
//
// The paste routes an image-only clipboard can take (#1196). The five paste
// entry points all funnel through pasteClipboardImage, so this is where the
// native-vs-path decision is actually exercised.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pasteClipboardImage } from '../imagePaste';
import { useStore } from '../../stores';

const PTY = 'pty-1';

function stubClipboard(opts: { hasImage: boolean; imagePath?: string | null }) {
  const readImage = vi.fn(async () => opts.imagePath ?? null);
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = {
    hasImage: vi.fn(async () => opts.hasImage),
    readImage,
  };
  return readImage;
}

function setPlatform(platform: string) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform };
}

beforeEach(() => {
  useStore.getState().clearSurfaceAgent(PTY);
  useStore.getState().setImagePasteMode('auto');
  setPlatform('darwin');
});

describe('pasteClipboardImage', () => {
  it('auto + Claude pane: sends the agent its own paste key and writes no temp file', async () => {
    const readImage = stubClipboard({ hasImage: true, imagePath: '/tmp/x.png' });
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'running', 'claude');
    const write = vi.fn();

    await expect(
      pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: true }),
    ).resolves.toBe(true);

    expect(write).toHaveBeenCalledWith('\x16');
    expect(readImage).not.toHaveBeenCalled();
  });

  it('auto + shell pane: falls back to the temp-PNG path, scoped to the pane', async () => {
    const readImage = stubClipboard({ hasImage: true, imagePath: '/tmp/wmux-paste-1.png' });
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: true });

    // ptyId goes to main so a WSL pane can be handed its /mnt view of the file.
    expect(readImage).toHaveBeenCalledWith(PTY);
    expect(write).toHaveBeenCalledWith('\x1b[200~/tmp/wmux-paste-1.png\x1b[201~');
  });

  it('quotes a spaced path and skips bracketed markers when the app has not enabled them', async () => {
    stubClipboard({ hasImage: true, imagePath: '/tmp/my shot.png' });
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false });

    expect(write).toHaveBeenCalledWith("'/tmp/my shot.png'");
  });

  it('falls back to the path route when the platform is unknown', async () => {
    const readImage = stubClipboard({ hasImage: true, imagePath: '/tmp/x.png' });
    useStore.getState().setImagePasteMode('native');
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false });

    // Guessing the key would be a silent no-op — the path route still delivers.
    expect(readImage).toHaveBeenCalledWith(PTY);
    expect(write).toHaveBeenCalledWith('/tmp/x.png');
  });

  it('path mode keeps the historical route even for a Claude pane', async () => {
    const readImage = stubClipboard({ hasImage: true, imagePath: '/tmp/x.png' });
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'running', 'claude');
    useStore.getState().setImagePasteMode('path');
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false });

    expect(readImage).toHaveBeenCalledWith(PTY);
    expect(write).toHaveBeenCalledWith('/tmp/x.png');
  });

  it('native mode on Windows sends Alt+V, which covers WSL panes too', async () => {
    stubClipboard({ hasImage: true, imagePath: 'C:\\Temp\\x.png' });
    useStore.getState().setImagePasteMode('native');
    setPlatform('win32');
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false });

    expect(write).toHaveBeenCalledWith('\x1bv');
  });

  it('writes nothing when the clipboard holds no image', async () => {
    stubClipboard({ hasImage: false });
    const write = vi.fn();

    await expect(
      pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not send the native key on an empty clipboard', async () => {
    stubClipboard({ hasImage: false });
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'running', 'claude');
    const write = vi.fn();

    // A keystroke on an empty clipboard would leave the agent in a state the
    // user never asked for.
    await expect(
      pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('path route still pastes when hasImage disagrees with readImage', async () => {
    // The keyboard paste sites never gated on hasImage; a clipboard the format
    // list does not call an image but readImage can decode must keep working.
    const readImage = stubClipboard({ hasImage: false, imagePath: '/tmp/x.png' });
    const write = vi.fn();

    await pasteClipboardImage({ ptyId: PTY, write, bracketedPasteMode: false });

    expect(readImage).toHaveBeenCalledWith(PTY);
    expect(write).toHaveBeenCalledWith('/tmp/x.png');
  });
});

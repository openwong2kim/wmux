import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock: the terminal must register an OSC 52 handler
 * that routes the decoded payload through the clipboard IPC, and dispose it on
 * teardown.
 *
 * Why source-level: the OSC 52 path only fires when xterm's parser consumes a
 * real escape sequence from live PTY data, which needs a real Terminal wired to
 * a renderer — jsdom can't faithfully drive it (the same constraint the
 * imeCopyPaste / rightClickPasteMouseMode locks in this dir document). The
 * decode + security policy is exhaustively unit-tested in
 * utils/__tests__/osc52Clipboard.test.ts; this lock pins the WIRING so a future
 * refactor can't silently drop it and regress TUI-app copy (Claude Code, vim,
 * tmux, neovim) back to the silent failure the handler fixed: the app shows
 * "copied" while the system clipboard never changes.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);
const PRELOAD_SRC = readFileSync(
  path.resolve(process.cwd(), 'src/preload/preload.ts'),
  'utf8',
);

describe('useTerminal OSC 52 clipboard-write wiring (source-level lock)', () => {
  it('registers an OSC 52 parser handler', () => {
    expect(SRC).toMatch(/registerOscHandler\(\s*52\s*,/);
  });

  it('routes the OSC 52 payload through the write-only decode policy', () => {
    // #998 moved the decode + the non-null guard into createOsc52Handler, in
    // the same module that owns the rest of the policy (reads and clears are
    // refused there too). What this locks is that the hook does not hand-roll
    // its own path to the clipboard — it goes through that factory.
    expect(SRC).toMatch(/createOsc52Handler\(\{/);
    expect(SRC).toMatch(/import \{ createOsc52Handler \} from '\.\.\/utils\/osc52Clipboard'/);
  });

  it('gates the handler on the replay mute (#998)', () => {
    // Replayed bytes are stored output, not a request: a reconnect, resync or
    // scrollback restore must not re-apply an old copy to the live clipboard.
    // Pinned on the predicate reaching the shared state machine, not on how the
    // boolean is spelled — replayMute.ts owns the parse-scoped lifetime.
    expect(SRC).toMatch(/isReplaying:\s*\(\)\s*=>\s*isReplayMuted\(replayMuteRef\.current\)/);
    expect(SRC).toMatch(/from '\.\.\/terminal\/replayMute'/);
  });

  it('uses source-labelled replay writes instead of a receive-time window (#1014)', () => {
    expect(SRC).toMatch(/onData\(\(ptyId, data, replay\)\s*=>\s*cb\(ptyId, \{[\s\S]{0,80}?replay:\s*replay\s*===\s*true/);
    expect(SRC).toMatch(/write:\s*payload\.replay\s*\?\s*writeReplayOutput\s*:\s*undefined/);
    expect(SRC).not.toMatch(/openReattachWindow|noteReplayData/);
  });

  it('treats legacy and local two-argument PTY data as live', () => {
    expect(PRELOAD_SRC).toMatch(/data:\s*string,\s*\n\s*replay\s*=\s*false/);
    expect(SRC).toMatch(/replay:\s*replay\s*===\s*true/);
  });

  it('daemon replay still proves the recovered PTY pipe is ready', () => {
    const connect = SRC.slice(SRC.indexOf('const connectPty'), SRC.indexOf('const connectPty') + 1200);
    expect(connect).toMatch(/routePtyData\(payload\);[\s\S]{0,120}?markPaneLive\(\);/);
    expect(connect).not.toMatch(/if \(payload\.replay\) return/);
  });

  it('writes the decoded text through the clipboard IPC (1 MB cap + lock handling)', () => {
    // Must reach window.clipboardAPI.writeText — the IPC that validates size and
    // surfaces lock failures — not a raw clipboard call that bypasses the cap.
    expect(SRC).toMatch(/clipboardAPI\.writeText\(text\)/);
  });

  it('disposes the OSC 52 handler on teardown (no leak across remounts)', () => {
    expect(SRC).toMatch(/osc52Disposable\.dispose\(\)/);
  });
});

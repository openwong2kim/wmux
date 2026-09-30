import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { Terminal } from '@xterm/headless';

/**
 * The web client's stale-replay mode reset, driven by the desktop's module.
 *
 * A snapshot re-arms the input modes the pane's output last left on — a TUI
 * that armed ?1003h (any-motion mouse) and exited without disabling it makes
 * the browser xterm type `35;55;12M…` into the shell on every pointer move.
 *
 * The shared code reaches the page as an esbuild IIFE of
 * src/shared/terminal/webTerminalShared.ts (scripts/build-daemon-web.mjs), so
 * this suite builds the same entry the same way and evaluates it. The app.js
 * half is `repaint` + `staleReplayTail`, sliced out of the shipped file and
 * evaluated verbatim against a real (headless) xterm — the rest of app.js
 * needs a DOM and is not evaluated, as in the sibling frontend suites.
 */

type Shared = {
  staleReplayResetLevel: (s: { resumeAgent?: string; commandRunning?: boolean } | undefined) => string;
  STALE_REPLAY_ALIVE_SHELL_RESETS: string;
  STALE_REPLAY_DISPLAY_RESETS: string;
  STALE_REPLAY_INPUT_MODE_RESETS: string;
};
type Repaint = (t: Terminal, bytes: string, inc: () => void, dec: () => void, tail?: string) => void;
type Tail = (meta: Record<string, unknown> | null) => string;

const repoRoot = join(__dirname, '..', '..', '..', '..');
// Windows CI checks the repo out with CRLF.
const readSource = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const appJs = readSource(join(__dirname, '..', 'frontend', 'app.js'));

let shared: Shared;
let repaint: Repaint;
let staleReplayTail: Tail;

beforeAll(() => {
  const bundle = buildSync({
    entryPoints: [join(repoRoot, 'src', 'shared', 'terminal', 'webTerminalShared.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'wmuxTerminalShared',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    logLevel: 'error',
  }).outputFiles[0].text;
  const pageGlobal: Record<string, unknown> = {};
  runInNewContext(bundle, pageGlobal);
  shared = pageGlobal.wmuxTerminalShared as Shared;

  const start = appJs.indexOf('  function repaint(');
  const end = appJs.indexOf('function staleReplayTail(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // Through the end of staleReplayTail: its closing brace is the first line
  // that is exactly two-space-indented `}` after its opening.
  const close = appJs.indexOf('\n  }\n', end);
  const src = appJs.slice(start, close + 4);
  const sandbox: Record<string, unknown> = { window: { wmuxTerminalShared: shared } };
  runInNewContext(`${src}\nthis.repaint = repaint; this.staleReplayTail = staleReplayTail;`, sandbox);
  repaint = sandbox.repaint as Repaint;
  staleReplayTail = sandbox.staleReplayTail as Tail;
});

/** Resolves once everything queued so far has been parsed. */
const flush = (t: Terminal) => new Promise<void>((resolve) => t.write('', resolve));

// What a claude that exited without cleaning up leaves at the end of the ring.
const LEAKED_TUI_MODES = '$ \x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h';

async function paintSnapshot(meta: Record<string, unknown> | null) {
  const t = new Terminal({ allowProposedApi: true });
  const emitted: string[] = [];
  t.onData((d) => emitted.push(d));
  let repaints = 0;
  // The gate count at the moment each DECRST (`CSI ? … l`) is parsed — the
  // reset tail is the only source of those here.
  const gateAtReset: number[] = [];
  t.parser.registerCsiHandler({ prefix: '?', final: 'l' }, () => { gateAtReset.push(repaints); return false; });
  repaint(t, LEAKED_TUI_MODES, () => { repaints += 1; }, () => { repaints -= 1; }, staleReplayTail(meta));
  await flush(t);
  return { t, emitted, repaints, gateAtReset };
}

describe('shared terminal bundle (wmuxTerminalShared)', () => {
  it('publishes the desktop gate and constants', () => {
    expect(shared.staleReplayResetLevel({ commandRunning: false })).toBe('mouse');
    expect(shared.staleReplayResetLevel({ commandRunning: true })).toBe('none');
    expect(shared.staleReplayResetLevel({})).toBe('none');
    expect(shared.staleReplayResetLevel({ resumeAgent: 'claude' })).toBe('full');
    expect(shared.STALE_REPLAY_ALIVE_SHELL_RESETS).toContain('\x1b[?1003l');
    expect(shared.STALE_REPLAY_ALIVE_SHELL_RESETS).not.toContain('\x1b[?2004l');
  });
});

describe('web snapshot repaint + stale-replay reset (app.js)', () => {
  it('★ shell at its prompt (commandRunning false): disarms mouse + focus, keeps bracketed paste', async () => {
    const { t, emitted, repaints } = await paintSnapshot({ cols: 80, rows: 24, commandRunning: false });
    try {
      expect(t.modes.mouseTrackingMode).toBe('none');
      expect(t.modes.sendFocusMode).toBe(false);
      // The live shell owns ?2004 — clearing it would desync paste wrapping.
      expect(t.modes.bracketedPasteMode).toBe(true);
      // The reset is terminal-side only and provokes nothing for onData.
      expect(emitted).toEqual([]);
      expect(repaints).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('★ the repaint gate stays held until the reset tail has parsed (no window for a leaked report)', async () => {
    const { t, repaints, gateAtReset } = await paintSnapshot({ cols: 80, rows: 24, commandRunning: false });
    try {
      expect(gateAtReset.length).toBeGreaterThan(0);
      expect(gateAtReset.every((n) => n > 0)).toBe(true);
      expect(repaints).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('★ recovered after a daemon restart (resumeAgent, no prompt state): disarms mouse + focus, NEVER bracketed paste', async () => {
    // The gate says 'full', but the recovered shell is alive and owns ?2004.
    // resumeAgent persists until re-detection, so clearing it here would break
    // multi-line paste (first line runs at once) on every attach.
    const { t, emitted, repaints } = await paintSnapshot({ cols: 80, rows: 24, resumeAgent: 'claude' });
    try {
      expect(t.modes.mouseTrackingMode).toBe('none');
      expect(t.modes.sendFocusMode).toBe(false);
      expect(t.modes.bracketedPasteMode).toBe(true);
      expect(emitted).toEqual([]);
      expect(repaints).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('a live command outranks resumeAgent, exactly as on the desktop', async () => {
    const { t } = await paintSnapshot({ cols: 80, rows: 24, resumeAgent: 'claude', commandRunning: true });
    try {
      expect(t.modes.mouseTrackingMode).toBe('any');
    } finally {
      t.dispose();
    }
  });

  it('releases the gate when either write throws, and never writes the tail after a failed snapshot', () => {
    const run = (throwOn: number) => {
      const writes: string[] = [];
      let n = 0;
      const fake = {
        reset() { /* no-op */ },
        write(data: string) {
          n += 1;
          if (n === throwOn) throw new Error('discard watermark');
          writes.push(data);
        },
      } as unknown as Terminal;
      let repaints = 0;
      repaint(fake, 'SNAP', () => { repaints += 1; }, () => { repaints -= 1; }, 'TAIL');
      return { writes, repaints };
    };
    expect(run(1)).toEqual({ writes: [], repaints: 0 });
    expect(run(2)).toEqual({ writes: ['SNAP'], repaints: 0 });
  });

  it('a running command (commandRunning true) keeps every mode the snapshot armed', async () => {
    const { t, emitted } = await paintSnapshot({ cols: 80, rows: 24, commandRunning: true });
    try {
      expect(t.modes.mouseTrackingMode).toBe('any');
      expect(t.modes.sendFocusMode).toBe(true);
      expect(t.modes.bracketedPasteMode).toBe(true);
      expect(emitted).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it('no prompt-state signal (meta without commandRunning) resets nothing', async () => {
    const { t } = await paintSnapshot({ cols: 80, rows: 24 });
    try {
      expect(t.modes.mouseTrackingMode).toBe('any');
    } finally {
      t.dispose();
    }
  });

  it('both snapshot handlers (1-up and split tile) pass the tail, and only a snapshot meta feeds it', () => {
    expect(appJs.match(/staleReplayTail\(snapMeta\)\)/g) ?? []).toHaveLength(2);
    expect(appJs.match(/if \(!m\.resize\) snapMeta = m;/g) ?? []).toHaveLength(2);
    // Every streamed pane has a live shell that owns ?2004: the web never
    // writes the full (bracketed-paste-clearing) reset.
    expect(appJs).not.toMatch(/STALE_REPLAY_INPUT_MODE_RESETS/);
    // Terminal-side only: the tail is never sent to the pane.
    expect(appJs).not.toMatch(/send(?:To)?\([^)]*staleReplayTail/);
  });

  it('the shared bundle is inlined into the page, ahead of app.js', () => {
    const html = readSource(join(__dirname, '..', 'frontend', 'index.html'));
    const sharedAt = html.indexOf('/*__TERMINAL_SHARED_JS__*/');
    expect(sharedAt).toBeGreaterThan(-1);
    expect(sharedAt).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    const build = readSource(join(repoRoot, 'scripts', 'build-daemon-web.mjs'));
    expect(build).toContain("inject(html, '/*__TERMINAL_SHARED_JS__*/', terminalSharedJs)");
    expect(build).toContain("globalName: 'wmuxTerminalShared'");
  });
});

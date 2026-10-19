import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writePidMap,
  removePidMapByPtyId,
  pruneDaemonPidMap,
  pruneDaemonPidMapAtConnect,
  staleDaemonPidFiles,
  liveDaemonPidEntries,
} from '../pidMap';
import { getPidMapDir } from '../../../shared/constants';

/**
 * Behavioral test for the pid-map fs primitives behind the ghost-identity fix.
 *
 * The structural test (src/main/ipc/__tests__/pty.handler.pidmap-prune.test.ts)
 * proves the dispose + session:died handlers CALL removePidMapByPtyId. This one
 * proves the call actually does the right thing on a real filesystem — the
 * content-keying invariant the whole ghost defense rests on: prune by file
 * CONTENT (ptyId), never by filename (the recyclable OS PID).
 *
 * getPidMapDir() resolves `${USERPROFILE || HOME}/.wmux${dataSuffix()}/pid-map` at call time,
 * so we redirect both env vars at a throwaway tmpdir and run the real code.
 */
describe('pidMap fs primitives', () => {
  let tmp: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;
  let mapDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    // getPidMapDir() prefers USERPROFILE, falls back to HOME — pin both so the
    // test is platform-independent.
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    mapDir = getPidMapDir();
    fs.mkdirSync(mapDir, { recursive: true });
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const seed = (pid: string | number, ptyId: string) =>
    fs.writeFileSync(path.join(mapDir, String(pid)), ptyId, 'utf8');
  const exists = (pid: string | number) =>
    fs.existsSync(path.join(mapDir, String(pid)));

  it('writePidMap creates the dir and writes ptyId as the file CONTENT', () => {
    writePidMap(1234, 'daemon-abc');
    expect(exists(1234)).toBe(true);
    expect(fs.readFileSync(path.join(mapDir, '1234'), 'utf8')).toBe('daemon-abc');
  });

  it('writePidMap keeps one PID per ptyId: an earlier shell of the same pane is removed', () => {
    // Live repro (Windows, after two daemon restarts): pane daemon-04f1c884
    // had PIDs 6780 and 13632 before its current shell 7644. Windows then
    // gave 6780 to a new worker's claude.exe, whose MCP walk matched it and
    // took the old pane's identity.
    seed(6780, 'daemon-04f1c884');
    seed(13632, 'daemon-04f1c884');
    seed(14932, 'daemon-d1fe97e3');
    writePidMap(7644, 'daemon-04f1c884');
    expect(exists(7644)).toBe(true);
    expect(exists(6780)).toBe(false);
    expect(exists(13632)).toBe(false);
    // Other panes' anchors are untouched.
    expect(fs.readFileSync(path.join(mapDir, '14932'), 'utf8')).toBe('daemon-d1fe97e3');
  });

  it('writePidMap over a recycled PID of another pane re-points it, leaving that pane\'s other anchors alone', () => {
    seed(500, 'daemon-old');
    seed(600, 'daemon-old');
    writePidMap(500, 'daemon-new');
    expect(fs.readFileSync(path.join(mapDir, '500'), 'utf8')).toBe('daemon-new');
    expect(fs.readFileSync(path.join(mapDir, '600'), 'utf8')).toBe('daemon-old');
  });

  it('removePidMapByPtyId deletes EVERY entry whose content matches the ptyId', () => {
    // The accretion case: one ptyId can have multiple PID anchors (shell
    // respawn / reconnect writes a fresh PID without removing the old one).
    // Pruning must sweep them all in one call.
    seed(100, 'daemon-A');
    seed(200, 'daemon-A');
    seed(300, 'daemon-B');

    removePidMapByPtyId('daemon-A');

    expect(exists(100)).toBe(false);
    expect(exists(200)).toBe(false);
    expect(exists(300)).toBe(true); // unrelated ptyId untouched
  });

  it('matches by CONTENT, not by filename — a PID-named file is NOT removed by PID', () => {
    // Guards the core ghost invariant. If the prune ever flipped to filename
    // matching, recycled-PID entries (the ones that produce ghosts) would
    // survive while a same-numbered live anchor got wrongly deleted.
    seed(555, 'daemon-X'); // filename "555", content "daemon-X"

    removePidMapByPtyId('555'); // ask to prune ptyId "555" — content, not name
    expect(exists(555)).toBe(true); // file named 555 stays (its content ≠ "555")

    removePidMapByPtyId('daemon-X'); // prune by actual content
    expect(exists(555)).toBe(false);
  });

  it('trims trailing whitespace/newline before comparing content', () => {
    // Anchors written by other paths may carry a trailing newline; the match
    // must be whitespace-insensitive or stale entries would never clear.
    fs.writeFileSync(path.join(mapDir, '777'), 'daemon-nl\n', 'utf8');
    removePidMapByPtyId('daemon-nl');
    expect(exists(777)).toBe(false);
  });

  it('is a safe no-op on empty ptyId and a missing map dir', () => {
    seed(900, 'daemon-keep');
    removePidMapByPtyId(''); // empty → must not nuke the whole dir
    expect(exists(900)).toBe(true);

    // Missing dir must not throw.
    fs.rmSync(mapDir, { recursive: true, force: true });
    expect(() => removePidMapByPtyId('daemon-anything')).not.toThrow();
  });

  describe('pruneDaemonPidMap (startup prune against the daemon session list)', () => {
    it('removes a file whose daemon ptyId the daemon does not have', () => {
      seed(100, 'daemon-gone');
      expect(pruneDaemonPidMap([{ id: 'daemon-live', pid: 200, state: 'detached' }])).toBe(1);
      expect(exists(100)).toBe(false);
    });

    it('removes a file whose PID is not the session\'s current shell PID', () => {
      // Live repro: after a daemon restart daemon-04f1c884 runs shell 7644,
      // but its file for the old shell 6780 was still there.
      seed(6780, 'daemon-04f1c884');
      seed(7644, 'daemon-04f1c884');
      pruneDaemonPidMap([{ id: 'daemon-04f1c884', pid: 7644, state: 'attached' }]);
      expect(exists(6780)).toBe(false);
      expect(exists(7644)).toBe(true);
    });

    it('keeps a file whose PID is the session\'s current shell PID', () => {
      seed(300, 'daemon-a');
      expect(pruneDaemonPidMap([{ id: 'daemon-a', pid: 300, state: 'detached' }])).toBe(0);
      expect(exists(300)).toBe(true);
    });

    it('keeps non-daemon content (local PTYManager panes, legacy ws- files)', () => {
      seed(400, 'pty-local-1');
      seed(401, 'ws-legacy');
      pruneDaemonPidMap([]);
      expect(exists(400)).toBe(true);
      expect(exists(401)).toBe(true);
    });

    it('keeps a file for a live session whose PID the daemon does not report', () => {
      seed(500, 'daemon-nopid');
      pruneDaemonPidMap([{ id: 'daemon-nopid', state: 'detached' }]);
      expect(exists(500)).toBe(true);
    });

    it('removes a file for a dead or suspended session even when the PID matches (no shell runs)', () => {
      // Tombstones and pending recoveries keep the ended shell's PID, which
      // the OS is free to reuse.
      seed(600, 'daemon-dead');
      seed(700, 'daemon-pending');
      pruneDaemonPidMap([
        { id: 'daemon-dead', pid: 600, state: 'dead' },
        { id: 'daemon-pending', pid: 700, state: 'suspended' },
      ]);
      expect(exists(600)).toBe(false);
      expect(exists(700)).toBe(false);
    });

    it('leaves a file that was rewritten after the snapshot it was judged on', () => {
      seed(800, 'daemon-old');
      const snapshot = [{ pid: '800', ptyId: 'daemon-old' }];
      seed(800, 'daemon-new'); // PID 800 re-anchored to a new pane meanwhile
      pruneDaemonPidMap([], snapshot);
      expect(fs.readFileSync(path.join(mapDir, '800'), 'utf8')).toBe('daemon-new');
    });

    it('staleDaemonPidFiles is pure and names only the stale PIDs', () => {
      const files = [
        { pid: '1', ptyId: 'daemon-a' },
        { pid: '2', ptyId: 'daemon-a' },
        { pid: '3', ptyId: 'daemon-b' },
        { pid: '4', ptyId: 'pty-local' },
      ];
      expect(staleDaemonPidFiles(files, [{ id: 'daemon-a', pid: 2, state: 'attached' }])).toEqual(['1', '3']);
    });
  });

  describe('pruneDaemonPidMapAtConnect', () => {
    it('reads the map before listing sessions, so a pane created during the RPC keeps its file', async () => {
      seed(100, 'daemon-stale');
      const removed = await pruneDaemonPidMapAtConnect(async () => {
        // A new pane is created while the RPC is in flight: its session is
        // not in this answer, but its file was written after the snapshot.
        seed(900, 'daemon-new');
        return [];
      });
      expect(removed).toBe(1);
      expect(exists(100)).toBe(false);
      expect(exists(900)).toBe(true);
    });

    it('removes nothing when the daemon fails or answers with something other than a list', async () => {
      seed(100, 'daemon-a');
      expect(await pruneDaemonPidMapAtConnect(async () => { throw new Error('daemon down'); })).toBe(0);
      expect(await pruneDaemonPidMapAtConnect(async () => ({ error: 'nope' }))).toBe(0);
      expect(exists(100)).toBe(true);
    });

    it('does not ask the daemon when the map holds no daemon entries', async () => {
      seed(100, 'pty-local');
      let asked = false;
      await pruneDaemonPidMapAtConnect(async () => { asked = true; return []; });
      expect(asked).toBe(false);
      expect(exists(100)).toBe(true);
    });
  });
});

describe('liveDaemonPidEntries (resolve-time check)', () => {
  const entry = (pid: string, ptyId: string) => ({ pid, ptyId, workspaceId: 'ws-1' });

  it('skips a stale file whose PID is not the session\'s current shell, keeping the real shell\'s entry', () => {
    const entries = [entry('6780', 'daemon-04f1c884'), entry('7644', 'daemon-04f1c884')];
    const kept = liveDaemonPidEntries(entries, [{ id: 'daemon-04f1c884', pid: 7644, state: 'detached' }]);
    expect(kept).toEqual([entry('7644', 'daemon-04f1c884')]);
  });

  it('keeps every entry when the daemon session list is unavailable', () => {
    const entries = [entry('6780', 'daemon-a'), entry('7644', 'daemon-a')];
    expect(liveDaemonPidEntries(entries, null)).toEqual(entries);
  });

  it('keeps non-daemon entries and live sessions without a PID', () => {
    const entries = [entry('1', 'pty-local'), entry('3', 'daemon-nopid')];
    expect(liveDaemonPidEntries(entries, [{ id: 'daemon-nopid', state: 'attached' }])).toEqual(entries);
  });

  it('drops an entry whose session the (complete) list does not have', () => {
    const entries = [entry('6780', 'daemon-gone'), entry('7644', 'daemon-worker')];
    expect(liveDaemonPidEntries(entries, [{ id: 'daemon-worker', pid: 7644, state: 'attached' }]))
      .toEqual([entry('7644', 'daemon-worker')]);
  });

  it('drops entries for a dead or suspended session', () => {
    const entries = [entry('10', 'daemon-dead'), entry('20', 'daemon-pending')];
    expect(liveDaemonPidEntries(entries, [
      { id: 'daemon-dead', pid: 10, state: 'dead' },
      { id: 'daemon-pending', pid: 20, state: 'suspended' },
    ])).toEqual([]);
  });
});

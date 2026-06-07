import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePidMap, removePidMapByPtyId } from '../pidMap';

/**
 * Behavioral test for the pid-map fs primitives behind the ghost-identity fix.
 *
 * The structural test (src/main/ipc/__tests__/pty.handler.pidmap-prune.test.ts)
 * proves the dispose + session:died handlers CALL removePidMapByPtyId. This one
 * proves the call actually does the right thing on a real filesystem — the
 * content-keying invariant the whole ghost defense rests on: prune by file
 * CONTENT (ptyId), never by filename (the recyclable OS PID).
 *
 * getPidMapDir() resolves `${USERPROFILE || HOME}/.wmux/pid-map` at call time,
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
    mapDir = path.join(tmp, '.wmux', 'pid-map');
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
});

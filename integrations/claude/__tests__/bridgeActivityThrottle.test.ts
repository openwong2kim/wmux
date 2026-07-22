/**
 * Source-side PostToolUse throttle (30-session scaling).
 *
 * Every PostToolUse hook used to open a fresh main-pipe connection even though
 * the server keeps only ~1 activity signal per pane per 3s
 * (hooks.rpc.ts ACTIVITY_THROTTLE_MS) and drops the rest. At N sessions × M
 * parallel subagents the discarded calls still stormed the pipe's
 * pending-accept instances and its 30-conn/s admission cap. The bridge now
 * suppresses sends inside ACTIVITY_STAMP_THROTTLE_MS per throttle key via a
 * zero-byte stamp file's mtime, failing OPEN (send) on any fs error.
 *
 * Same harness as bridgePermissionMode.test.ts: strip the CLI entrypoint,
 * re-export the functions under test, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let fakeHome: string;
let shouldThrottle: (key: string) => boolean;
let stampPathFor: (key: string) => string;
let savedUserProfile: string | undefined;
let savedHome: string | undefined;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-throttle-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { shouldThrottleActivity, getActivityStampPath };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({
    shouldThrottleActivity: shouldThrottle,
    getActivityStampPath: stampPathFor,
  } = await import(pathToFileURL(mod).href));

  savedUserProfile = process.env.USERPROFILE;
  savedHome = process.env.HOME;
});

beforeEach(() => {
  // Fresh fake home per test so stamps never leak between cases.
  fakeHome = mkdtempSync(path.join(tmp, 'home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('shouldThrottleActivity', () => {
  it('lets the first call through and stamps it', () => {
    expect(shouldThrottle('pty-1')).toBe(false);
    expect(existsSync(stampPathFor('pty-1'))).toBe(true);
  });

  it('suppresses a second call inside the window', () => {
    expect(shouldThrottle('pty-1')).toBe(false);
    expect(shouldThrottle('pty-1')).toBe(true);
  });

  it('lets the call through again once the stamp ages past the window', () => {
    expect(shouldThrottle('pty-1')).toBe(false);
    const stamp = stampPathFor('pty-1');
    const old = (Date.now() - 10_000) / 1000; // well past ACTIVITY_STAMP_THROTTLE_MS
    utimesSync(stamp, old, old);
    expect(shouldThrottle('pty-1')).toBe(false);
  });

  it('throttles per key — a different pane is not suppressed', () => {
    expect(shouldThrottle('pty-1')).toBe(false);
    expect(shouldThrottle('pty-2')).toBe(false);
    expect(shouldThrottle('pty-2')).toBe(true);
  });

  it('sanitizes hostile keys into distinct stamp files under the stamp dir', () => {
    const p = stampPathFor('..\\..\\evil/../key');
    const dir = path.join(fakeHome, '.wmux', 'activity-stamps');
    expect(path.dirname(p)).toBe(dir);
    expect(path.basename(p)).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('fails open (send) when the stamp dir cannot exist', () => {
    // Occupy the stamp dir's path with a FILE so mkdir/stat/write all fail.
    const wmuxDir = path.join(fakeHome, '.wmux');
    mkdirSync(wmuxDir, { recursive: true });
    writeFileSync(path.join(wmuxDir, 'activity-stamps'), 'not a dir', 'utf8');
    expect(shouldThrottle('pty-1')).toBe(false);
    expect(shouldThrottle('pty-1')).toBe(false); // still open on repeat
  });
});

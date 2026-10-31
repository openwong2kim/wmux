// The company seat cleanup against real folders: which paths count as a seat
// worktree.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapedWorktreeDir } from '../../worktask/PhoneWorktreeRemoval';
import { COMPANY_SEAT_SHAPE } from '../seatCleanupRule';

const HASH = 'abc123def456';
const SLUG = 'dev-1-456789ab';
let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seat-cleanup-')));
  root = path.join(base, 'company-worktrees');
  fs.mkdirSync(path.join(root, HASH, '.meta', SLUG), { recursive: true });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('the company seat folder shape', () => {
  it('accepts the folders seatLaunches makes', () => {
    const dir = path.join(root, HASH, SLUG);
    fs.mkdirSync(dir);
    expect(shapedWorktreeDir(root, dir, COMPANY_SEAT_SHAPE)).toBe(dir);
    // A label with no slug leaves the workspace id's suffix alone.
    const bare = path.join(root, HASH, '456789ab');
    fs.mkdirSync(bare);
    expect(shapedWorktreeDir(root, bare, COMPANY_SEAT_SHAPE)).toBe(bare);
  });

  it('refuses .meta, the wrong depth, a repository folder that is not 12 hex, and a link', () => {
    fs.mkdirSync(path.join(root, HASH, SLUG, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'not-a-hash', SLUG), { recursive: true });
    for (const bad of [
      path.join(root, HASH, '.meta'),
      path.join(root, HASH, '.meta', SLUG),
      path.join(root, HASH),
      root,
      path.join(root, HASH, SLUG, 'src'),
      path.join(root, 'not-a-hash', SLUG),
      `${root}/${HASH}/../${HASH}/${SLUG}/..`,
    ]) {
      expect(shapedWorktreeDir(root, bad, COMPANY_SEAT_SHAPE)).toBeNull();
    }
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, HASH, 'linked-456789ab'), 'dir');
    expect(shapedWorktreeDir(root, path.join(root, HASH, 'linked-456789ab'), COMPANY_SEAT_SHAPE)).toBeNull();
    // A repository folder that is a link leads elsewhere too.
    fs.symlinkSync(path.join(root, HASH), path.join(root, 'fedcba987654'), 'dir');
    expect(shapedWorktreeDir(root, path.join(root, 'fedcba987654', SLUG), COMPANY_SEAT_SHAPE)).toBeNull();
  });

  it('reports only the folder\'s own company branch', () => {
    expect(COMPANY_SEAT_SHAPE.branch(`company/${SLUG}`, SLUG)).toBe(true);
    expect(COMPANY_SEAT_SHAPE.branch('company/dev-2-456789ab', SLUG)).toBe(false);
    expect(COMPANY_SEAT_SHAPE.branch('feature/mine', SLUG)).toBe(false);
  });
});

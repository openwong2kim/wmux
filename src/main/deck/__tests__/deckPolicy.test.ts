// Unit tests for deckPolicy (the binding operator-policy channel). All
// filesystem cases run against a real tmp dir; no electron, no SDK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadDeckPolicyBlock,
  ensureDeckPolicySeed,
  getDeckPolicyPath,
  DEFAULT_POLICY_BUDGET_CHARS,
} from '../deckPolicy';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-policy-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeckPolicyBlock', () => {
  it('returns null when the policy file is missing', () => {
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(getDeckPolicyPath(dir), '   \n\t\n');
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });

  it('wraps the file content under the BINDING header', () => {
    fs.writeFileSync(getDeckPolicyPath(dir), '- deploy only from main');
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('## Operator policy (BINDING standing rules)');
    expect(block).toContain('These rules are authoritative');
    // The safety ceiling is stated in the header.
    expect(block).toContain('risky or irreversible');
    // The operator content is included verbatim.
    expect(block).toContain('- deploy only from main');
  });

  it('truncates an oversize file with an announced notice (never silent)', () => {
    const huge = '- rule '.repeat(DEFAULT_POLICY_BUDGET_CHARS); // well over budget
    fs.writeFileSync(getDeckPolicyPath(dir), huge);
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('[policy truncated to fit the turn budget');
    // Body is capped at the budget (header + notice add a small fixed overhead).
    expect(block.length).toBeLessThan(DEFAULT_POLICY_BUDGET_CHARS + 500);
  });

  it('never throws — a directory in place of the file resolves to null', () => {
    fs.mkdirSync(getDeckPolicyPath(dir)); // readFileSync on a dir throws → caught
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });
});

describe('ensureDeckPolicySeed', () => {
  it('creates the seed file once with the example worktree rule', () => {
    expect(fs.existsSync(getDeckPolicyPath(dir))).toBe(false);
    ensureDeckPolicySeed(dir);
    const seeded = fs.readFileSync(getDeckPolicyPath(dir), 'utf8');
    expect(seeded).toContain('isolated git worktree');
    // The seed is loadable and wrapped under the binding header.
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('## Operator policy (BINDING standing rules)');
    expect(block).toContain('isolated git worktree');
  });

  it('NEVER overwrites an existing policy file (operator edits are sacred)', () => {
    const custom = '- my own rule that must survive';
    fs.writeFileSync(getDeckPolicyPath(dir), custom);
    ensureDeckPolicySeed(dir);
    ensureDeckPolicySeed(dir); // idempotent, still no overwrite
    expect(fs.readFileSync(getDeckPolicyPath(dir), 'utf8')).toBe(custom);
  });

  it('creates the data dir first when it does not exist yet (fresh-profile race)', () => {
    // Live dogfood regression: on a brand-new WMUX_DATA_SUFFIX, main's seed can
    // run before the daemon has created ~/.wmux{suffix}. The write must mkdir -p
    // its parent, not swallow an ENOENT and silently never seed.
    const freshDir = path.join(dir, 'not', 'yet', 'created');
    expect(fs.existsSync(freshDir)).toBe(false);
    ensureDeckPolicySeed(freshDir);
    expect(fs.existsSync(getDeckPolicyPath(freshDir))).toBe(true);
    expect(loadDeckPolicyBlock(freshDir)!).toContain('isolated git worktree');
  });
});

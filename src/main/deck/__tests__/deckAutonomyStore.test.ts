// Unit tests for the per-workspace autonomy store: fail-closed resolution,
// round-trip persistence, sanitize-on-load (the file is hand-editable), the
// merge-write path, AND the agent-mode layer (mode ⇄ caps, legacy derivation).
// Security-load-bearing property: the DANGEROUS cap (approvalPress) is never
// on unless a workspace is explicitly `danger`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTONOMY,
  DEFAULT_MODE,
  modeToCaps,
  modeToWakePolicy,
  deriveMode,
  loadWorkspaceAutonomy,
  loadWorkspaceMode,
  loadDeckAutonomy,
  setWorkspaceAutonomy,
  setWorkspaceMode,
  getDeckAutonomyPath,
  type AgentMode,
} from '../deckAutonomyStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-auto-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckAutonomyStore — mode ⇄ caps', () => {
  it('modeToCaps: only danger turns on the dangerous approvalPress cap', () => {
    expect(modeToCaps('off')).toEqual({ summarize: false, continueInstruction: false, approvalPress: false });
    expect(modeToCaps('assist')).toEqual({ summarize: true, continueInstruction: true, approvalPress: false });
    expect(modeToCaps('danger')).toEqual({ summarize: true, continueInstruction: true, approvalPress: true });
  });

  it('modeToWakePolicy maps each mode', () => {
    expect(modeToWakePolicy('off')).toBe('none');
    expect(modeToWakePolicy('assist')).toBe('value-filtered');
    expect(modeToWakePolicy('danger')).toBe('all');
  });

  it('deriveMode back-maps legacy caps by the dangerous caps', () => {
    expect(deriveMode({ summarize: true, continueInstruction: false, approvalPress: true })).toBe('danger');
    expect(deriveMode({ summarize: true, continueInstruction: true, approvalPress: false })).toBe('assist');
    // all-off legacy (the pre-mode "report only" default) → the product default.
    expect(deriveMode({ summarize: true, continueInstruction: false, approvalPress: false })).toBe(DEFAULT_MODE);
  });

  it('DEFAULT is the product default mode (off), every cap off', () => {
    expect(DEFAULT_MODE).toBe('off');
    expect(DEFAULT_AUTONOMY).toEqual({
      mode: 'off',
      wakePolicy: 'none',
      summarize: false,
      continueInstruction: false,
      approvalPress: false,
    });
  });
});

describe('deckAutonomyStore', () => {
  it('unknown workspace resolves to DEFAULT', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadWorkspaceMode('ws-1', dir)).toBe('off');
  });

  it('setWorkspaceMode round-trips mode + derived caps', async () => {
    const next = await setWorkspaceMode('ws-1', 'danger', dir);
    expect(next).toEqual({
      mode: 'danger',
      // No entry existed, so the wake policy is seeded from the mode.
      wakePolicy: 'all',
      summarize: true,
      continueInstruction: true,
      approvalPress: true,
    });
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual(next);
    expect(loadWorkspaceMode('ws-1', dir)).toBe('danger');
  });

  it('setWorkspaceMode off writes the all-off caps', async () => {
    const next = await setWorkspaceMode('ws-1', 'off', dir);
    expect(next).toEqual({
      mode: 'off',
      wakePolicy: 'none',
      summarize: false,
      continueInstruction: false,
      approvalPress: false,
    });
  });

  it('setWorkspaceMode does NOT clobber an explicitly stored wakePolicy', async () => {
    // The two axes are independent: an operator who narrowed (or widened) what
    // wakes this workspace must keep that when the launch posture changes.
    await setWorkspaceMode('ws-1', 'danger', dir);
    await setWorkspaceAutonomy('ws-1', { wakePolicy: 'value-filtered' }, dir);
    const next = await setWorkspaceMode('ws-1', 'assist', dir);
    expect(next.mode).toBe('assist');
    expect(next.wakePolicy).toBe('value-filtered');
    // The other direction too: a stored 'all' survives a drop to assist, which
    // the old derive-on-write would have silently narrowed.
    await setWorkspaceAutonomy('ws-1', { wakePolicy: 'all' }, dir);
    expect((await setWorkspaceMode('ws-1', 'assist', dir)).wakePolicy).toBe('all');
  });

  it('an unknown mode string is a no-op returning DEFAULT (never writes)', async () => {
    const r = await setWorkspaceMode('ws-1', 'bogus' as AgentMode, dir);
    expect(r).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });

  it('legacy mode strings are no longer writable', async () => {
    for (const legacy of ['orchestrate', 'manual', 'auto']) {
      const r = await setWorkspaceMode('ws-1', legacy as AgentMode, dir);
      expect(r).toEqual({ ...DEFAULT_AUTONOMY });
      expect(loadDeckAutonomy(dir)).toEqual({});
    }
  });

  it('setWorkspaceAutonomy (cap-only patch) PRESERVES the stored mode', async () => {
    await setWorkspaceMode('ws-1', 'danger', dir);
    // The loop cap-override path patches ONLY caps — the mode AND the wake
    // policy must survive.
    const next = await setWorkspaceAutonomy('ws-1', { continueInstruction: false }, dir);
    expect(next.mode).toBe('danger');
    expect(next.wakePolicy).toBe('all');
    expect(next.continueInstruction).toBe(false);
  });

  it('missing / corrupt file fails closed to DEFAULT (never throws)', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    fs.writeFileSync(getDeckAutonomyPath(dir), 'CORRUPT{', 'utf8');
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });

  it('legacy entries with NO mode field back-derive one from caps', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-legacy-orch': { summarize: true, continueInstruction: true, approvalPress: true },
        'ws-legacy-assist': { summarize: true, continueInstruction: true, approvalPress: false },
        'ws-legacy-default': { summarize: true, continueInstruction: false, approvalPress: false },
      }),
      'utf8',
    );
    expect(loadWorkspaceMode('ws-legacy-orch', dir)).toBe('danger');
    expect(loadWorkspaceMode('ws-legacy-assist', dir)).toBe('assist');
    // pre-mode "report only" default → the new product default (off, opt-in).
    expect(loadWorkspaceMode('ws-legacy-default', dir)).toBe('off');
  });

  it('legacy mode strings in the FILE map to the new modes', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-manual': { mode: 'manual', summarize: false, continueInstruction: false, approvalPress: false },
        'ws-orch': { mode: 'orchestrate', summarize: true, continueInstruction: true, approvalPress: true },
        // The pre-rename danger mode. The whole point of the map entry: an
        // existing install keeps its bypass-launch workspace after the rename.
        'ws-auto': { mode: 'auto', summarize: true, continueInstruction: true, approvalPress: true },
      }),
      'utf8',
    );
    expect(loadWorkspaceMode('ws-manual', dir)).toBe('off');
    expect(loadWorkspaceMode('ws-orch', dir)).toBe('danger');
    expect(loadWorkspaceMode('ws-auto', dir)).toBe('danger');
  });

  it('an entry with no wakePolicy gets the MODE-DERIVED default (migration)', () => {
    // Every pre-split file looks like this. The seeded policy has to be the one
    // the entry already behaved with, or the split silently changes what wakes
    // an existing workspace.
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-off': { mode: 'off', summarize: false, continueInstruction: false, approvalPress: false },
        'ws-assist': { mode: 'assist', summarize: true, continueInstruction: true, approvalPress: false },
        'ws-auto': { mode: 'auto', summarize: true, continueInstruction: true, approvalPress: true },
      }),
      'utf8',
    );
    expect(loadWorkspaceAutonomy('ws-off', dir).wakePolicy).toBe('none');
    expect(loadWorkspaceAutonomy('ws-assist', dir).wakePolicy).toBe('value-filtered');
    // Legacy-mapped to danger FIRST, then the policy derived from that.
    expect(loadWorkspaceAutonomy('ws-auto', dir).wakePolicy).toBe('all');
  });

  it('a stored wakePolicy is used as-is; a bogus one falls back to the mode', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-1': { mode: 'assist', wakePolicy: 'all', summarize: true, continueInstruction: true, approvalPress: false },
        'ws-2': { mode: 'assist', wakePolicy: 'nonsense', summarize: true, continueInstruction: true, approvalPress: false },
      }),
      'utf8',
    );
    expect(loadWorkspaceAutonomy('ws-1', dir).wakePolicy).toBe('all');
    expect(loadWorkspaceAutonomy('ws-2', dir).wakePolicy).toBe('value-filtered');
  });

  it('a stored valid mode field is used as-is', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({ 'ws-1': { mode: 'assist', summarize: true, continueInstruction: true, approvalPress: false } }),
      'utf8',
    );
    expect(loadWorkspaceMode('ws-1', dir)).toBe('assist');
  });

  it('an invalid stored mode string falls back to deriveMode(caps)', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({ 'ws-1': { mode: 'bogus', summarize: true, continueInstruction: false, approvalPress: true } }),
      'utf8',
    );
    // caps have approval on → derives danger.
    expect(loadWorkspaceMode('ws-1', dir)).toBe('danger');
  });

  it('a bad workspaceId never writes a key and returns DEFAULT', async () => {
    const r = await setWorkspaceMode('bad key!', 'danger', dir);
    expect(r).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });
});

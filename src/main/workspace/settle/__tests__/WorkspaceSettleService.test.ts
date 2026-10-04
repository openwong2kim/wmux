import { describe, expect, it } from 'vitest';
import type { AgentStatus, PrStatus } from '../../../../shared/types';
import type { WorkspaceMirrorPushPayload } from '../../../../shared/workspaceMirror';
import type { WorkspaceSettleChange } from '../../../../shared/workspaceSettle';
import {
  INPUT_ACTIVITY_THROTTLE_MS,
  parsePersistedWorkspaceSettle,
  WorkspaceSettleService,
  type PersistedWorkspaceSettle,
} from '../WorkspaceSettleService';
import { isTerminalReplyOnly, PR_SETTLE_QUIET_MS } from '../workspaceSettleRules';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);

interface WsSpec {
  id: string;
  status?: AgentStatus;
  ptyId?: string;
}

function mirror(specs: WsSpec[], opts: { pinned?: string[]; restored?: boolean } = {}): WorkspaceMirrorPushPayload {
  return {
    ts: 0,
    entries: specs.map((s) => ({ id: s.id, name: s.id, activePtyId: s.ptyId ?? `pty-${s.id}`, ptyIds: [s.ptyId ?? `pty-${s.id}`] })),
    fleets: specs.map((s) => ({
      workspaceId: s.id,
      ts: 0,
      panes: [{ ptyId: s.ptyId ?? `pty-${s.id}`, agentName: null, agentStatus: s.status ?? 'idle', isActivePane: true }],
    })),
    pinnedIds: opts.pinned ?? [],
    sessionRestored: opts.restored ?? true,
  };
}

function setup(opts: { load?: unknown; hqId?: () => string | null } = {}) {
  let now = T0;
  let saved: PersistedWorkspaceSettle | null = null;
  const svc = new WorkspaceSettleService({
    now: () => now,
    load: () => opts.load ?? null,
    save: (d) => { saved = d; },
    hqId: opts.hqId,
  });
  const changes: WorkspaceSettleChange[] = [];
  svc.onChange((p) => changes.push(...p.changes));
  return {
    svc,
    changes,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    saved: () => saved,
    state: (id: string) => svc.snapshot().states[id],
  };
}

const merged = (n = 7): PrStatus => ({ number: n, state: 'merged', checks: 'passing', url: `https://example.test/pr/${n}` });
const open = (n = 7): PrStatus => ({ number: n, state: 'open', checks: 'passing', url: `https://example.test/pr/${n}` });

describe('WorkspaceSettleService — settle rules', () => {
  it('settles a workspace idle for the configured days, not before', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.advance(3 * DAY - 1000);
    t.svc.tick();
    expect(t.state('a')).toBeUndefined();
    t.advance(1000);
    t.svc.tick();
    expect(t.state('a')?.settled?.reason).toBe('idle');
    expect(t.changes.at(-1)).toMatchObject({ workspaceId: 'a', kind: 'settled', cause: 'idle', undoable: true });
  });

  it('honours a changed idle-days setting', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.advance(DAY);
    expect(t.svc.command({ op: 'setIdleDays', days: 1 })).toMatchObject({ ok: true, snapshot: { idleDays: 1 } });
    // Not on the keystroke: the next tick applies it.
    expect(t.state('a')).toBeUndefined();
    t.svc.tick();
    expect(t.state('a')?.settled?.reason).toBe('idle');
  });

  it('settles on a merged PR once the workspace has been quiet, and activity brings it back', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.svc.notePr('a', merged(), undefined);
    t.svc.tick();
    expect(t.state('a')).toBeUndefined();
    t.advance(PR_SETTLE_QUIET_MS);
    t.svc.tick();
    expect(t.state('a')?.settled?.reason).toBe('pr');
    t.svc.noteLifecycle('a', 'agent.stop');
    expect(t.state('a')).toBeUndefined();
    expect(t.changes.at(-1)).toMatchObject({ kind: 'unsettled', cause: 'activity', undoable: false });
  });

  it('exempts pinned, HQ, running and awaiting workspaces', () => {
    const t = setup({ hqId: () => 'hq' });
    t.svc.noteMirror(mirror(
      [{ id: 'pinned' }, { id: 'hq' }, { id: 'run', status: 'running' }, { id: 'ask', status: 'awaiting_input' }, { id: 'idle' }],
      { pinned: ['pinned'] },
    ));
    t.advance(10 * DAY);
    t.svc.tick();
    const states = t.svc.snapshot().states;
    expect(Object.keys(states)).toEqual(['idle']);
    for (const id of ['pinned', 'hq', 'run', 'ask']) {
      expect(t.svc.command({ op: 'settle', workspaceId: id })).toEqual({ ok: false, error: 'refused' });
    }
  });

  it('pinning a settled workspace un-settles it', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.advance(4 * DAY);
    t.svc.tick();
    expect(t.state('a')?.settled).toBeDefined();
    t.svc.noteMirror(mirror([{ id: 'a' }], { pinned: ['a'] }));
    expect(t.state('a')).toBeUndefined();
    expect(t.changes.at(-1)).toMatchObject({ kind: 'unsettled', cause: 'exempt' });
  });
});

describe('WorkspaceSettleService — un-settle on activity', () => {
  function settled() {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.svc.notePr('a', open(), 2);
    t.advance(4 * DAY);
    t.svc.tick();
    expect(t.state('a')?.settled).toBeDefined();
    return t;
  }

  it('un-settles on input, throttled per PTY', () => {
    const t = settled();
    t.svc.noteInput('pty-a', 'x');
    expect(t.state('a')).toBeUndefined();
    t.advance(4 * DAY);
    t.svc.tick();
    expect(t.state('a')?.settled).toBeDefined();
    t.svc.noteInput('pty-a', 'x');
    expect(t.state('a')).toBeUndefined();
    const lastCount = t.changes.length;
    t.advance(INPUT_ACTIVITY_THROTTLE_MS - 1);
    t.svc.noteInput('pty-a', 'x');
    expect(t.changes.length).toBe(lastCount);
  });

  it('ignores what the terminal writes back on its own', () => {
    const t = settled();
    t.svc.noteInput('pty-a', '\x1b[I');
    t.svc.noteInput('pty-a', '\x1b[?1;2c\x1b[12;40R');
    t.svc.noteInput('pty-a', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
    expect(t.state('a')?.settled).toBeDefined();
    t.svc.noteInput('pty-a', '\x1b[A');
    expect(t.state('a')).toBeUndefined();
  });

  it('tells terminal replies from keys', () => {
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?62;22c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[3;1R', '\x1b[?2026;2$y', '\x1b[?1u', '\x1bP>|xterm\x1b\\', '\x1b]10;rgb:0/0/0\x07']) {
      expect(isTerminalReplyOnly(reply)).toBe(true);
    }
    for (const key of ['a', '\r', '\x1b', '\x1b[A', '\x1b[13;2u', '\x1b[200~hi\x1b[201~', '\x1b[I x', '\x1b[<0;10;5M']) {
      expect(isTerminalReplyOnly(key)).toBe(false);
    }
  });

  it('un-settles when the agent runs', () => {
    const t = settled();
    t.svc.noteMirror(mirror([{ id: 'a', status: 'running' }]));
    expect(t.state('a')).toBeUndefined();
  });

  it('un-settles on new commits and on a reopened PR', () => {
    const t = settled();
    t.svc.notePr('a', open(), 3);
    expect(t.state('a')).toBeUndefined();

    const u = setup();
    u.svc.noteMirror(mirror([{ id: 'a' }]));
    u.svc.notePr('a', merged(), undefined);
    u.advance(PR_SETTLE_QUIET_MS);
    u.svc.tick();
    expect(u.state('a')?.settled?.reason).toBe('pr');
    u.svc.notePr('a', open(), undefined);
    expect(u.state('a')).toBeUndefined();
  });
});

describe('WorkspaceSettleService — snooze', () => {
  it('expires with an undoable unsnooze change', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    expect(t.svc.command({ op: 'snooze', workspaceId: 'a', until: t.now() + 60_000 }).ok).toBe(true);
    expect(t.state('a')?.snoozedUntil).toBe(t.now() + 60_000);
    t.advance(60_000);
    t.svc.tick();
    expect(t.state('a')).toBeUndefined();
    expect(t.changes.at(-1)).toMatchObject({ kind: 'unsnoozed', cause: 'expired', undoable: true });
  });

  it('wakes on attention, and an undo holds while the agent keeps waiting', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.svc.command({ op: 'snooze', workspaceId: 'a', until: t.now() + DAY });
    t.svc.noteMirror(mirror([{ id: 'a', status: 'awaiting_input' }]));
    expect(t.state('a')).toBeUndefined();
    const wake = t.changes.at(-1)!;
    expect(wake).toMatchObject({ kind: 'unsnoozed', cause: 'attention', undoable: true });
    expect(t.svc.command({ op: 'undo', changeId: wake.id }).ok).toBe(true);
    expect(t.state('a')?.snoozedUntil).toBeGreaterThan(t.now());
    // Same level, no new edge: stays snoozed.
    t.svc.noteMirror(mirror([{ id: 'a', status: 'awaiting_input' }]));
    expect(t.state('a')?.snoozedUntil).toBeDefined();
    // A CI failure is a new attention event.
    t.svc.noteAttention('a');
    expect(t.state('a')).toBeUndefined();
  });

  it('refuses to snooze a pinned workspace and rejects a past time', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }, { id: 'b' }], { pinned: ['a'] }));
    expect(t.svc.command({ op: 'snooze', workspaceId: 'a', until: t.now() + 1000 })).toEqual({ ok: false, error: 'refused' });
    expect(t.svc.command({ op: 'snooze', workspaceId: 'b', until: t.now() })).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('WorkspaceSettleService — undo', () => {
  it('undoing an idle settle restarts the idle clock', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.advance(4 * DAY);
    t.svc.tick();
    const settle = t.changes.at(-1)!;
    expect(t.svc.command({ op: 'undo', changeId: settle.id }).ok).toBe(true);
    t.advance(60_000);
    t.svc.tick();
    expect(t.state('a')).toBeUndefined();
  });

  it('undoing a PR settle stops that PR state from settling again', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.svc.notePr('a', merged(), undefined);
    t.advance(PR_SETTLE_QUIET_MS);
    t.svc.tick();
    const settle = t.changes.at(-1)!;
    t.svc.command({ op: 'undo', changeId: settle.id });
    t.advance(PR_SETTLE_QUIET_MS * 2);
    t.svc.tick();
    expect(t.state('a')).toBeUndefined();
  });

  it('undoes a manual snooze and refuses a stale change id', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }]));
    t.svc.command({ op: 'snooze', workspaceId: 'a', until: t.now() + DAY });
    const snooze = t.changes.at(-1)!;
    expect(snooze).toMatchObject({ kind: 'snoozed', undoable: true });
    t.advance(10_000);
    expect(t.svc.command({ op: 'undo', changeId: snooze.id })).toEqual({ ok: false, error: 'unknown-change' });
    t.svc.command({ op: 'unsnooze', workspaceId: 'a' });
    t.svc.command({ op: 'snooze', workspaceId: 'a', until: t.now() + DAY });
    expect(t.svc.command({ op: 'undo', changeId: t.changes.at(-1)!.id }).ok).toBe(true);
    expect(t.state('a')).toBeUndefined();
  });
});

describe('WorkspaceSettleService — persistence', () => {
  it('does not rewrite the file for every status push of a running agent', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a', status: 'running' }]));
    const first = t.saved();
    t.advance(300);
    t.svc.noteMirror(mirror([{ id: 'a', status: 'running' }]));
    expect(t.saved()).toBe(first);
    t.advance(30_000);
    t.svc.noteMirror(mirror([{ id: 'a', status: 'running' }]));
    expect(t.saved()).not.toBe(first);
  });

  it('round-trips through the persisted shape', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }, { id: 'b' }]));
    t.svc.command({ op: 'setIdleDays', days: 5 });
    t.svc.command({ op: 'settle', workspaceId: 'a' });
    t.svc.command({ op: 'snooze', workspaceId: 'b', until: t.now() + DAY });
    const saved = JSON.parse(JSON.stringify(t.saved()));
    const reloaded = setup({ load: saved });
    expect(reloaded.svc.snapshot()).toEqual(t.svc.snapshot());
  });

  it('drops malformed rows and clamps idle days', () => {
    const parsed = parsePersistedWorkspaceSettle({
      idleDays: 999,
      rows: { ok: { lastActivityAt: 1, settled: { at: 2, reason: 'idle' } }, bad: { lastActivityAt: 'x' }, odd: { lastActivityAt: 1, settled: { at: 2, reason: 'nope' } } },
    });
    expect(parsed.idleDays).toBe(90);
    expect([...parsed.rows.keys()]).toEqual(['ok', 'odd']);
    expect(parsed.rows.get('odd')?.settled).toBeUndefined();
  });

  it('forgets closed workspaces only when the tree came from the saved session', () => {
    const t = setup();
    t.svc.noteMirror(mirror([{ id: 'a' }, { id: 'b' }]));
    t.svc.command({ op: 'settle', workspaceId: 'b' });
    t.svc.noteMirror(mirror([{ id: 'a' }], { restored: false }));
    expect(t.saved()?.rows.b).toBeDefined();
    t.svc.noteMirror(mirror([{ id: 'a' }], { restored: true }));
    expect(t.saved()?.rows.b).toBeUndefined();
  });
});

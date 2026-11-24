import { describe, it, expect, vi } from 'vitest';
import {
  accountSignInMark, isSkip, noteContinuedBeside, paneWslMap, resetSwitchStateForTests, switchWorkspacePanes, wasContinuedBeside, tallySwitch, workspaceContinuePanes, workspaceRunsInWsl,
} from '../switchWorkspacePanes';
import type { ContinueOutcome } from '../../Pane/usePaneContinueOnAccount';
import type { WorkspacePaneOwner } from '../../../../shared/paneUtils';

const surface = (ptyId: string, title: string) => ({ id: `s-${ptyId}`, ptyId, title, shell: '', cwd: '' });
const ws = {
  rootPane: { type: 'leaf', id: 'p1', activeSurfaceId: 's-a', surfaces: [surface('a', '#w1-1'), surface('sh', '#w1-2')] },
  stashedPanes: [{ pane: { type: 'leaf', id: 'p2', activeSurfaceId: 's-b', surfaces: [surface('b', '#w1-3')] } }],
} as unknown as WorkspacePaneOwner;

describe('switching a workspace\'s open panes to an account', () => {
  it('takes the Claude panes, stashed ones too, and leaves shell panes and other agents out', () => {
    expect(workspaceContinuePanes(ws, { a: { slug: 'claude' }, b: { slug: 'claude' }, sh: undefined }, 'claude'))
      .toEqual([{ ptyId: 'a', title: '#w1-1' }, { ptyId: 'b', title: '#w1-3' }]);
    expect(workspaceContinuePanes(ws, { a: { slug: 'codex' } }, 'codex')).toEqual([]);
    // Only the vendor's own agent: a Claude account never takes another agent's pane.
    expect(workspaceContinuePanes(ws, { a: { slug: 'claude' } }, 'codex')).toEqual([]);
  });

  it('runs one pane at a time and keeps going after a failure or a throw', async () => {
    const order: string[] = [];
    let open = 0;
    const outcomes: Record<string, ContinueOutcome | Error> = {
      a: { kind: 'failed' }, b: new Error('boom'), c: { kind: 'done' },
    };
    const results = await switchWorkspacePanes(
      [{ ptyId: 'a', title: 'A' }, { ptyId: 'b', title: 'B' }, { ptyId: 'c', title: 'C' }],
      async (ptyId) => {
        open++;
        expect(open).toBe(1);
        order.push(ptyId);
        await Promise.resolve();
        open--;
        const o = outcomes[ptyId];
        if (o instanceof Error) throw o;
        return o;
      },
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.outcome.kind)).toEqual(['failed', 'failed', 'done']);
  });

  it('counts a pane in a turn as skipped, a new pane beside apart, a stop without relaunch as failed', () => {
    const r = (outcome: ContinueOutcome) => ({ ptyId: 'x', title: 'x', outcome });
    expect(tallySwitch([
      r({ kind: 'done' }), r({ kind: 'new_pane' }), r({ kind: 'refused', code: 'same_account' }),
      r({ kind: 'refused', code: 'turn_open' }), r({ kind: 'stopped', code: 'shell_busy', resumeCommand: 'claude -r x' }), r({ kind: 'failed' }),
    ])).toEqual({ switched: 1, opened: 1, already: 1, skipped: 1, failed: 2 });
  });

  it('only refusals before the stop are skips; a broken copy, a timeout or an unknown code is a failure', () => {
    for (const code of ['turn_open', 'busy', 'folder_trust', 'not_claude', 'unsupported', 'invalid_account', 'unavailable', 'still_running', 'no_session', 'not_signed_in']) {
      expect(isSkip({ kind: 'refused', code })).toBe(true);
    }
    for (const code of ['diverged', 'copy_failed', 'unknown_session', 'pending', 'something_new', 'same_account']) {
      expect(isSkip({ kind: 'refused', code })).toBe(false);
    }
    expect(tallySwitch([{ ptyId: 'x', title: 'x', outcome: { kind: 'refused', code: 'pending' } }]).failed).toBe(1);
  });

  it('leaves out, silently, a pane gone or no longer the agent by its step', async () => {
    const run = vi.fn(async () => ({ kind: 'done' as const }));
    const results = await switchWorkspacePanes([{ ptyId: 'a', title: 'A' }, { ptyId: 'b', title: 'B' }], run, (id) => id !== 'b');
    expect(results.map((r) => r.ptyId)).toEqual(['a']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('remembers a pane continued beside per workspace and account', () => {
    resetSwitchStateForTests();
    noteContinuedBeside('ws', 'acc', 'p1');
    expect(wasContinuedBeside('ws', 'acc', 'p1')).toBe(true);
    expect(wasContinuedBeside('ws', 'other', 'p1')).toBe(false);
    expect(wasContinuedBeside('ws2', 'acc', 'p1')).toBe(false);
  });
});

describe('an account\'s sign-in mark in the workspace account menu', () => {
  const out = { status: { loggedIn: false } };
  it('is never red "logged out" where the workspace\'s panes run in WSL', () => {
    expect(accountSignInMark(out, false)).toBe('out');
    expect(accountSignInMark(out, true)).toBe('wsl');
    expect(accountSignInMark({ status: { loggedIn: true } }, true)).toBe('in');
    expect(accountSignInMark({ ...out, tokenSignIn: { usable: true } }, false)).toBe('in');
  });

  it('reads WSL per open pane, and calls the workspace WSL only when all are (or, none open, a new pane would be)', () => {
    const sessions = [
      { id: 'a', shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] },
      { id: 'n', shell: 'pwsh.exe' },
      { id: 't', shell: 'pwsh.exe', wslTarget: { distribution: 'Ubuntu', user: 'me' } },
    ];
    expect(paneWslMap(['a', 'n', 't', 'gone'], sessions)).toEqual({ a: true, n: false, t: true, gone: false });
    expect(workspaceRunsInWsl(paneWslMap(['a', 't'], sessions), 'powershell')).toBe(true);
    // One native pane needs the Windows sign-in.
    expect(workspaceRunsInWsl(paneWslMap(['a', 'n'], sessions), 'wsl.exe')).toBe(false);
    expect(workspaceRunsInWsl({}, 'C:\\Windows\\System32\\wsl.exe')).toBe(true);
    expect(workspaceRunsInWsl({}, 'powershell')).toBe(false);
  });
});

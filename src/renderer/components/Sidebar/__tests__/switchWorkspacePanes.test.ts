import { describe, it, expect } from 'vitest';
import {
  accountSignInMark, switchWorkspacePanes, tallySwitch, workspaceContinuePanes, workspaceRunsInWsl,
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
    expect(workspaceContinuePanes(ws, { a: { slug: 'claude' }, b: { slug: 'claude' }, sh: undefined }))
      .toEqual([{ ptyId: 'a', title: '#w1-1' }, { ptyId: 'b', title: '#w1-3' }]);
    expect(workspaceContinuePanes(ws, { a: { slug: 'codex' } })).toEqual([]);
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

  it('counts a pane in a turn as skipped, one already on the account as switched, a stop without relaunch as failed', () => {
    const r = (outcome: ContinueOutcome) => ({ ptyId: 'x', title: 'x', outcome });
    expect(tallySwitch([
      r({ kind: 'done' }), r({ kind: 'new_pane' }), r({ kind: 'refused', code: 'same_account' }),
      r({ kind: 'refused', code: 'turn_open' }), r({ kind: 'stopped', code: 'shell_busy', resumeCommand: 'claude -r x' }), r({ kind: 'failed' }),
    ])).toEqual({ switched: 2, already: 1, skipped: 1, failed: 2 });
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

  it('reads WSL from the open panes, or from the default shell when none is open', () => {
    const sessions = [
      { id: 'a', shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] },
      { id: 'n', shell: 'pwsh.exe' },
      { id: 't', shell: 'pwsh.exe', wslTarget: { distribution: 'Ubuntu', user: 'me' } },
    ];
    expect(workspaceRunsInWsl(['n'], sessions, 'wsl.exe')).toBe(false);
    expect(workspaceRunsInWsl(['n', 'a'], sessions, 'powershell')).toBe(true);
    expect(workspaceRunsInWsl(['t'], sessions, 'powershell')).toBe(true);
    expect(workspaceRunsInWsl([], sessions, 'C:\\Windows\\System32\\wsl.exe')).toBe(true);
    expect(workspaceRunsInWsl([], sessions, 'powershell')).toBe(false);
  });
});

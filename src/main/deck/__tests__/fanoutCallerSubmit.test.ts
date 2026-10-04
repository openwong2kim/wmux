import { describe, it, expect, vi } from 'vitest';
import { createFanoutCallerSubmit, type FanoutCallerSubmitPorts } from '../fanoutCallerSubmit';

const LINE = '[wmux] fan-out task 6k7g7szw updated — channel_mission_list';
const REQ = { ptyId: 'pty-c', ownerWorkspaceId: 'ws-owner', incarnationId: 'inc-1', text: LINE };

function make(over: Partial<FanoutCallerSubmitPorts> = {}) {
  const deliver = vi.fn(async () => ({ result: 'sent' as const, pasted: true }));
  const ports: FanoutCallerSubmitPorts = {
    deliveryGate: async () => null,
    ownerOf: async () => 'ws-owner',
    agentState: async () => ({ agentName: 'Claude Code', agentVerified: true, incarnationId: 'inc-1' }),
    deliver,
    ...over,
  };
  return { api: createFanoutCallerSubmit(ports), deliver: (over.deliver ?? deliver) as ReturnType<typeof vi.fn> };
}

describe('createFanoutCallerSubmit', () => {
  it('hands a verified, owned, same-session write to the daemon', async () => {
    const { api, deliver } = make();
    expect(await api.submit(REQ)).toEqual({ result: 'sent', pasted: true });
    expect(deliver).toHaveBeenCalledWith({ id: 'pty-c', agentSlug: 'claude', incarnationId: 'inc-1', prompt: LINE });
  });

  it('refuses any text that is not the fixed template', async () => {
    const { api, deliver } = make();
    expect(await api.submit({ ...REQ, text: '[wmux] fan-out task x updated; rm -rf ~ — channel_mission_list' })).toEqual({
      result: 'error',
      pasted: false,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('re-checks the gate, the owner and the session right before the write', async () => {
    const cases: Array<[Partial<FanoutCallerSubmitPorts>, string]> = [
      [{ deliveryGate: async () => ({ ok: false, reason: 'approval_pending', detail: '' }) }, 'approval_pending'],
      [{ deliveryGate: async () => ({ ok: false, reason: 'usage_limited', detail: '' }) }, 'held'],
      [{ ownerOf: async () => 'ws-elsewhere' }, 'gone'],
      [{ agentState: async () => ({ agentName: 'Claude Code', agentVerified: false, incarnationId: 'inc-1' }) }, 'gone'],
      [{ agentState: async () => ({ agentName: 'Claude Code', agentVerified: true, incarnationId: 'inc-2' }) }, 'session_changed'],
    ];
    for (const [over, result] of cases) {
      const { api, deliver } = make(over);
      expect(await api.submit(REQ)).toEqual({ result, pasted: false });
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('a PR owner line is written only while the pane still shows that PR, number and url', async () => {
    const PR_LINE = '[wmux] PR #123: CI failed — gh pr checks 123';
    const URL = 'https://github.com/o/r/pull/123';
    const PR_REQ = { ...REQ, text: PR_LINE, prs: [{ number: 123, url: URL }] };
    const ok = make({ prOf: () => ({ number: 123, url: URL }) });
    expect(await ok.api.submit(PR_REQ)).toEqual({ result: 'sent', pasted: true });
    expect(ok.deliver).toHaveBeenCalledWith({ id: 'pty-c', agentSlug: 'claude', incarnationId: 'inc-1', prompt: PR_LINE });
    for (const prOf of [
      () => ({ number: 7, url: URL }),
      // Same number, another repo.
      () => ({ number: 123, url: 'https://github.com/x/y/pull/123' }),
      () => null,
      undefined,
    ]) {
      const { api, deliver } = make(prOf ? { prOf } : {});
      expect(await api.submit(PR_REQ)).toEqual({ result: 'pr_changed', pasted: false });
      expect(deliver).not.toHaveBeenCalled();
    }
    // A PR the line names but the request does not claim is refused outright.
    expect(await make({ prOf: () => ({ number: 123, url: URL }) }).api.submit({ ...REQ, text: PR_LINE })).toEqual({
      result: 'error',
      pasted: false,
    });
    // A fan-out-only line needs no PR.
    expect(await make().api.submit(REQ)).toEqual({ result: 'sent', pasted: true });
  });

  it('proves the PR after the last await: a branch switch during the agent check is caught', async () => {
    const PR_LINE = '[wmux] PR #123: CI failed — gh pr checks 123';
    const URL = 'https://github.com/o/r/pull/123';
    let current: { number: number; url: string } | null = { number: 123, url: URL };
    const { api, deliver } = make({
      prOf: () => current,
      agentState: async () => {
        current = null; // the pane changed branch while this was in flight
        return { agentName: 'Claude Code', agentVerified: true, incarnationId: 'inc-1' };
      },
    });
    expect(await api.submit({ ...REQ, text: PR_LINE, prs: [{ number: 123, url: URL }] })).toEqual({ result: 'pr_changed', pasted: false });
    expect(deliver).not.toHaveBeenCalled();
  });

    it('session answers only for a verified agent', async () => {
    expect(await make().api.session('pty-c')).toEqual({ incarnationId: 'inc-1' });
    expect(await make({ agentState: async () => null }).api.session('pty-c')).toBeNull();
    expect(
      await make({ agentState: async () => ({ agentName: null, agentVerified: true, incarnationId: 'inc-1' }) }).api.session('pty-c'),
    ).toBeNull();
  });
});

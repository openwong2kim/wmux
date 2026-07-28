// ─── A1: pane-pinned channel mentions, end to end ────────────────────────────
//
// `channel_post` gained a `pane_id` mention field so an orchestrator can aim a
// mention at ONE agent. Before it, the MCP caller had no vocabulary for "this
// pane", so an agent-addressed mention could never be auto-delivered — the
// delivery path requires a pane pin and there was no way to express one.
//
// These tests walk the WHOLE chain rather than one layer, because the failure
// they guard against lived in the seam between layers:
//   ChannelService.post (daemon: validate + pin)
//     → routeChannelMentionToInbox (receiving renderer: mint the inbox task)
//       → flushMentions (receiving renderer: paste the nudge into the pty)
// Every step is a pure function, so the chain runs in one file with no app.
//
// Three properties, one per test:
//  ① a pane-pinned mention is actually pasted into that pane's pty
//  ② a mention with no pane pin stays badge-only (adversarial review F1 —
//     a workspace-level ping must never be auto-pasted into "the one agent")
//  ③ a pin naming a pane of ANOTHER workspace is REFUSED and reported, so the
//     new field cannot become a cross-workspace paste primitive

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type { ChannelState, ChannelMessage } from '../../../shared/channels';
import { panePrincipalId } from '../../../shared/principals';
import { routeChannelMentionToInbox } from '../../../renderer/hooks/channelMentionInbox';
import { flushMentions, type FlushMentionDeps } from '../../../renderer/hooks/channelMentionFlush';
import type { Task, PaneLeaf, Surface } from '../../../shared/types';

// ── daemon side fixtures ─────────────────────────────────────────────────────

function makeWriter() {
  let lastSaved: ChannelState | null = null;
  const fresh = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  return {
    saveImmediate: vi.fn((state: ChannelState) => {
      lastSaved = JSON.parse(JSON.stringify(state)) as ChannelState;
      return true;
    }),
    saveDebounced: vi.fn(),
    load: vi.fn((): ChannelState => (lastSaved ? JSON.parse(JSON.stringify(lastSaved)) as ChannelState : fresh())),
  };
}

/** Stand-in for the daemon's principal registry lookup (wired in
 *  src/daemon/index.ts from PrincipalService.find). `panes` lists the REAL
 *  (workspaceId, paneId, ptyId) pane-agents; anything else resolves to
 *  undefined, which is the "cannot prove this pane is yours" answer. */
function makePaneRegistry(panes: { workspaceId: string; paneId: string; ptyId: string }[]) {
  const byId = new Map(panes.map((p) => [panePrincipalId(p.workspaceId, p.paneId), p.ptyId]));
  return (workspaceId: string, paneId: string) => {
    const ptyId = byId.get(panePrincipalId(workspaceId, paneId));
    return ptyId ? { ptyId } : undefined;
  };
}

async function makeChannelWith(
  members: { workspaceId: string; memberId: string }[],
  panes: { workspaceId: string; paneId: string; ptyId: string }[],
) {
  const emit = vi.fn<ChannelServiceEmit>();
  const writer = makeWriter();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit,
    now: () => 1_700_000_000_000,
    resolvePanePrincipal: makePaneRegistry(panes),
  });
  const created = await svc.create({
    name: 'mission',
    visibility: 'public',
    createdBy: { workspaceId: members[0].workspaceId, memberId: members[0].memberId },
    verifiedWorkspaceId: members[0].workspaceId,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  for (const m of members.slice(1)) {
    const joined = await svc.join({
      channelId: created.channel.id,
      member: { workspaceId: m.workspaceId, memberId: m.memberId },
      verifiedWorkspaceId: m.workspaceId,
    });
    if (!joined.ok) throw new Error(`join failed: ${joined.error.code}`);
  }
  return { svc, channelId: created.channel.id };
}

// ── receiving-renderer fixtures ──────────────────────────────────────────────

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
}
function leaf(id: string, surfaces: Surface[]): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}

/**
 * Run the receiving workspace's half: route the posted message into its a2a
 * inbox, then flush queued mentions to their panes. Returns the ptys that were
 * actually pasted into — the observable "did it land in an agent's prompt".
 */
function deliverTo(
  message: ChannelMessage,
  selfWorkspaceId: string,
  leaves: PaneLeaf[],
  agentPtys: string[],
): { pastedPtys: string[]; routedTaskIds: string[] } {
  const tasks = new Map<string, Task>();
  const handled = new Set<string>();
  const routedTaskIds = routeChannelMentionToInbox(message, selfWorkspaceId, leaves, {
    getTask: (id) => tasks.get(id),
    createA2aTask: (t) => {
      tasks.set(t.id!, {
        kind: 'task',
        id: t.id!,
        status: { state: 'submitted', timestamp: '2020-01-01T00:00:00Z' },
        history: t.history,
        artifacts: t.artifacts,
        metadata: {
          title: t.title,
          from: t.from,
          to: t.to,
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-01T00:00:00Z',
        },
      } as Task);
      return t.id!;
    },
    channelName: () => 'mission',
    workspaceName: (id) => id,
    publish: () => {
      // The a2a.task pointer is not part of what these tests observe.
    },
    isHandled: (k) => handled.has(k),
    markHandled: (k) => handled.add(k),
  });

  const pasted: string[] = [];
  const marked = new Set<string>();
  const deps: FlushMentionDeps = {
    getUndeliveredChannelMentionTasks: () => [...tasks.values()].filter((t) => !marked.has(t.id)),
    isBusy: () => false, // the worker is idle — the case the whole feature is for
    deliverNudge: (ptyId) => pasted.push(ptyId),
    markDelivered: (id) => marked.add(id),
    agentPtys: new Set(agentPtys),
  };
  flushMentions(selfWorkspaceId, leaves, deps, {});
  return { pastedPtys: pasted, routedTaskIds };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('A1 — pane-pinned channel mentions', () => {
  it('① a pane-pinned mention is delivered into that pane\'s pty', async () => {
    // ws-worker runs two agents; the orchestrator aims at the SECOND one.
    const { svc, channelId } = await makeChannelWith(
      [
        { workspaceId: 'ws-orch', memberId: 'lead' },
        { workspaceId: 'ws-worker', memberId: 'worker' },
      ],
      [
        { workspaceId: 'ws-worker', paneId: 'pane-1', ptyId: 'pty-1' },
        { workspaceId: 'ws-worker', paneId: 'pane-2', ptyId: 'pty-2' },
      ],
    );
    const post = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
      text: '@worker start step 2',
      // The MCP shape: pane pinned, NO ptyId supplied by the caller.
      mentions: [{ workspaceId: 'ws-worker', paneId: 'pane-2', name: 'worker' }],
    });
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error('post failed');
    expect(post.droppedMentions).toBeUndefined();
    // The daemon kept the pin AND filled the route-time pty snapshot from the
    // registry — the caller never had to know (or be able to forge) a ptyId.
    expect(post.message.mentions).toEqual([
      { workspaceId: 'ws-worker', name: 'worker', paneId: 'pane-2', ptyId: 'pty-2' },
    ]);

    const leaves = [leaf('pane-1', [surface('s1', 'pty-1')]), leaf('pane-2', [surface('s2', 'pty-2')])];
    const { pastedPtys } = deliverTo(post.message, 'ws-worker', leaves, ['pty-1', 'pty-2']);
    // Landed in the prompt of the pinned agent — and only that one.
    expect(pastedPtys).toEqual(['pty-2']);
  });

  it('② a mention with no pane pin stays badge-only, even with a single live agent (F1)', async () => {
    const { svc, channelId } = await makeChannelWith(
      [
        { workspaceId: 'ws-orch', memberId: 'lead' },
        { workspaceId: 'ws-worker', memberId: 'worker' },
      ],
      [{ workspaceId: 'ws-worker', paneId: 'pane-1', ptyId: 'pty-1' }],
    );
    const post = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
      text: '@worker fyi',
      mentions: [{ workspaceId: 'ws-worker', name: 'worker' }], // no pane_id
    });
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error('post failed');
    expect(post.message.mentions).toEqual([{ workspaceId: 'ws-worker', name: 'worker' }]);

    const leaves = [leaf('pane-1', [surface('s1', 'pty-1')])];
    const { routedTaskIds, pastedPtys } = deliverTo(post.message, 'ws-worker', leaves, ['pty-1']);
    // The task IS minted (the dock badge / a2a_task_query pull path)…
    expect(routedTaskIds).toHaveLength(1);
    // …but nothing is pasted into the sole live agent. Default behavior is
    // unchanged by A1: only an explicit pin opens the prompt.
    expect(pastedPtys).toEqual([]);
  });

  it('③ a pin naming a pane of ANOTHER workspace is refused and reported', async () => {
    // pane-x really exists — in ws-other. The attacker mentions ws-victim (a
    // channel member) but pins ws-other's pane, hoping the pin survives and the
    // victim's renderer pastes the nudge into whatever agent it can find.
    const { svc, channelId } = await makeChannelWith(
      [
        { workspaceId: 'ws-orch', memberId: 'lead' },
        { workspaceId: 'ws-victim', memberId: 'victim' },
      ],
      [
        { workspaceId: 'ws-other', paneId: 'pane-x', ptyId: 'pty-x' },
        { workspaceId: 'ws-victim', paneId: 'pane-v', ptyId: 'pty-v' },
      ],
    );
    const post = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
      text: '@victim look',
      mentions: [{ workspaceId: 'ws-victim', paneId: 'pane-x', name: 'victim' }],
    });
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error('post failed');
    // The pin is stripped — the persisted mention carries no pane coordinate,
    // so it degrades to the badge-only workspace mention of case ②.
    expect(post.message.mentions).toEqual([{ workspaceId: 'ws-victim', name: 'victim' }]);
    // …and the refusal is REPORTED, not silently swallowed.
    expect(post.droppedMentions).toEqual([
      { workspaceId: 'ws-victim', paneId: 'pane-x', name: 'victim', reason: 'pane_not_in_workspace' },
    ]);

    // The victim's own single live agent is NOT pasted into: the degraded
    // single-agent path keys on the pane pin, which no longer exists.
    const leaves = [leaf('pane-v', [surface('sv', 'pty-v')])];
    const { pastedPtys } = deliverTo(post.message, 'ws-victim', leaves, ['pty-v']);
    expect(pastedPtys).toEqual([]);
  });

  it('an unknown pane id under the caller\'s OWN mention target is refused too (fail closed)', async () => {
    // Not an attack, just staleness (the pane closed). Same rule: an unprovable
    // pin never becomes a paste; the mention still lands as a badge.
    const { svc, channelId } = await makeChannelWith(
      [
        { workspaceId: 'ws-orch', memberId: 'lead' },
        { workspaceId: 'ws-worker', memberId: 'worker' },
      ],
      [{ workspaceId: 'ws-worker', paneId: 'pane-1', ptyId: 'pty-1' }],
    );
    const post = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
      text: '@worker ping',
      mentions: [{ workspaceId: 'ws-worker', paneId: 'pane-gone', name: 'worker' }],
    });
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error('post failed');
    expect(post.message.mentions).toEqual([{ workspaceId: 'ws-worker', name: 'worker' }]);
    expect(post.droppedMentions).toEqual([
      { workspaceId: 'ws-worker', paneId: 'pane-gone', name: 'worker', reason: 'pane_not_in_workspace' },
    ]);
  });

  it('without the registry resolver the pin stays opaque pass-through (unit-test construction)', async () => {
    // The gate is an injected dependency; production always wires it
    // (src/daemon/index.ts). This pins the documented absent-resolver behavior
    // so a construction site that forgets it degrades to the pre-A1 semantics
    // rather than silently refusing every pin.
    const writer = makeWriter();
    const svc = new ChannelService({
      writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
      companyId: 'co-test',
      emit: vi.fn<ChannelServiceEmit>(),
      now: () => 1_700_000_000_000,
    });
    const created = await svc.create({
      name: 'mission',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
    });
    if (!created.ok) throw new Error('create failed');
    const post = await svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-orch', memberId: 'lead' },
      verifiedWorkspaceId: 'ws-orch',
      text: 'self ping',
      mentions: [{ workspaceId: 'ws-orch', paneId: 'pane-1', ptyId: 'pty-1', name: 'lead' }],
    });
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error('post failed');
    expect(post.message.mentions).toEqual([
      { workspaceId: 'ws-orch', name: 'lead', paneId: 'pane-1', ptyId: 'pty-1' },
    ]);
    expect(post.droppedMentions).toBeUndefined();
  });
});

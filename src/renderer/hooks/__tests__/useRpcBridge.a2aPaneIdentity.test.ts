import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Wiring guards for Part A (pane-level A2A identity + addressing). The pure
 * address logic is unit-tested in a2aAddressing.test.ts; useRpcBridge itself
 * can't be imported under vitest (pulls in the store/window), so these are
 * source-structural assertions that the derivations + addressing stay wired.
 */
describe('useRpcBridge — pane-level A2A identity wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) throw new Error(`region ${start} → ${end} not found in useRpcBridge.ts`);
    return m[0];
  }

  it('surface.list labels each surface from the surfaceAgent map', () => {
    const block = region("method === 'surface\\.list'", 'return surfaces;');
    expect(block).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    expect(block).toMatch(/agentName:/);
    expect(block).toMatch(/agentStatus:/);
  });

  it('pane.list exposes per-leaf agents derived from surfaceAgent', () => {
    const block = region("method === 'pane\\.list'", 'return leaves\\.map');
    // the agents[] derivation lives in the leaves.map body
    const mapBody = region("method === 'pane\\.list'", 'pane\\.focus');
    expect(mapBody).toMatch(/agents:\s*l\.surfaces\.flatMap/);
    expect(mapBody).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    void block;
  });

  it('a2a.discover returns per-pane addressable entries', () => {
    const block = region("method === 'a2a\\.discover'", "method === 'a2a\\.task\\.send'");
    expect(block).toMatch(/panes/);
    expect(block).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    expect(block).toMatch(/paneId:/);
    expect(block).toMatch(/surfaceId:/);
  });

  it('a2a.task.send resolves an explicit address and HARD-rejects an invalid one (no active-pane fallback)', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    expect(block).toMatch(/resolvePaneAddress\(findLeafPanes\(target\.rootPane\)/);
    // an 'error' from the resolver short-circuits the send
    expect(block).toMatch(/if \('error' in addr\) return \{ error: `a2a\.task\.send:/);
    // reply pins to the originally-addressed pane
    expect(block).toMatch(/resolvePaneAddress\(findLeafPanes\(targetWs\.rootPane\)/);
    // reply fails CLOSED when the pinned address no longer resolves (no
    // active-pane fallback that could land on the wrong agent)
    expect(block).toMatch(/pinnedAddressLost/);
    // the resolved target ws id is returned for the main-side execute path
    expect(block).toMatch(/toWorkspaceId: target\.id/);
  });

  it('a2a.task.send replaces the whole-ws self-guard with per-pane decideSameWsSend', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    // the old workspace-granular guard is gone (it blocked legitimate sibling sends)
    expect(block).not.toMatch(/cannot send to yourself/);
    // the relocated guard runs AFTER address resolution, keyed on the sender's
    // own verified ptyId (threaded from the MCP server as params.senderPtyId)
    expect(block).toMatch(/const rawSenderPtyId = typeof params\.senderPtyId === 'string'/);
    expect(block).toMatch(/decideSameWsSend\(target\.id === workspaceId, resolvedAddr\?\.ptyId, senderPtyId\)/);
    expect(block).toMatch(/sameWsDecision\.kind === 'reject'/);
    // new-task delivery is gated by suppressPaste (silent OR same-ws-can't-prove-non-self)
    expect(block).toMatch(/const suppressPaste = silent \|\| sameWsDecision\.suppressPaste/);
    expect(block).toMatch(/if \(!suppressPaste\)/);
    // S-C2: the same-ws reply is no longer blanket-suppressed — it pins to the
    // SYMMETRIC from/to anchor and suppresses ONLY on no-anchor or self-loop,
    // delivering a one-line nudge to a proven sibling (never a full-body paste).
    expect(block).toMatch(/const sameWsTask = task\.metadata\.from\.workspaceId === task\.metadata\.to\.workspaceId/);
    expect(block).toMatch(/const pinAnchor = replyingToReceiver \? task\.metadata\.to : task\.metadata\.from/);
    expect(block).toMatch(/const sameWsNoAnchor = sameWsTask && !hasAnchor/);
    expect(block).toMatch(/const selfLoop = !!explicitPty && !!callerPtyId && explicitPty === callerPtyId/);
    // an unverified same-ws caller (no senderPtyId) is suppressed: ws-level role
    // defaults to 'user' and would self-route the nudge to the caller's own pane
    expect(block).toMatch(/const sameWsUnverified = sameWsTask && !callerPtyId/);
  });

  it('a2a.task.send computes the reply role per-pane (S-C2) with a ws-level fallback', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    // caller pane resolved from the verified senderPtyId, then role-per-pane with
    // an exact ws-level fallback (cross-ws behavior preserved)
    expect(block).toMatch(/const callerAddr = resolveSenderPaneAddress\(callerLeaves, callerPtyId\)/);
    expect(block).toMatch(/resolvePaneRole\(task\.metadata, callerAddr\)/);
    // a verified third-party pane (neither from nor to) in a fully-anchored
    // same-ws task is rejected instead of defaulting to the ws-level 'user' role
    expect(block).toMatch(/caller pane is not a participant of this task/);
  });

  it('a2a.task.send validates senderPtyId provenance against the sender workspace', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    // a foreign/bogus senderPtyId is treated as absent (→ safe silent fallback)
    expect(block).toMatch(/const senderLeaves = sender \? findLeafPanes\(sender\.rootPane\) : \[\]/);
    expect(block).toMatch(/isTerminalPtyInLeaves\(senderLeaves, rawSenderPtyId\)/);
    // S-C2: the validated senderPtyId is captured as the `from` pane anchor
    expect(block).toMatch(/const senderAddr = resolveSenderPaneAddress\(senderLeaves, senderPtyId\)/);
  });

  it('a2a.task.send gates execute:true before creating or delivering the task', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    expect(block).toMatch(/const executeRequested = params\.execute === true/);
    expect(block).toMatch(/execute is only supported for new tasks/);
    const approvalIdx = block.indexOf('requestExecuteApproval({');
    const createIdx = block.indexOf('store.createA2aTask({');
    const deliveryIdx = block.indexOf('const suppressPaste = silent || sameWsDecision.suppressPaste');
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(approvalIdx);
    expect(deliveryIdx).toBeGreaterThan(createIdx);
    expect(block).toMatch(/executeApproved: executeRequested/);
  });

  it('a2a.task.update mirrors the reply branch: per-pane role, symmetric pin + self-loop, pane-granular authz', () => {
    const block = region("method === 'a2a\\.task\\.update'", 'addTaskArtifact');
    // per-pane role + symmetric pin (same model as the reply branch)
    expect(block).toMatch(/resolvePaneRole\(task\.metadata, callerAddrUpdate\)/);
    expect(block).toMatch(/caller pane is not a participant of this task/);
    expect(block).toMatch(/const pinAnchor = replyingToReceiver \? task\.metadata\.to : task\.metadata\.from/);
    // same-ws is pinned + nudged, suppressed only on no-anchor / self-loop
    expect(block).toMatch(/const sameWsNoAnchor = sameWsTask && !hasAnchor/);
    expect(block).toMatch(/const selfLoop = !!explicitPty && !!callerPtyIdUpdate && explicitPty === callerPtyIdUpdate/);
    expect(block).toMatch(/const sameWsUnverified = sameWsTask && !callerPtyIdUpdate/);
    // P2: pane-granular status authz threads the caller's pane into the store
    expect(block).toMatch(/updateTaskStatus\(taskId, nextState, workspaceId, callerAddrUpdate\)/);
  });
});

describe('mcp — A2A send threads the caller\'s own ptyId (KS-1 self-send guard)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'mcp', 'index.ts'),
    'utf-8',
  );
  it('captures MY_PTY_ID on a verified hit and forwards it as senderPtyId', () => {
    // hit path records the caller's own pane anchor inside the PID-map walk, so
    // the terminal-route warm path populates it too …
    expect(src).toMatch(/MY_PTY_ID = match\.ptyId/);
    // … and the send handler forwards it via getTaskSenderPtyId, which prefers
    // the verified MY_PTY_ID and falls back to the weak WMUX_PTY_ID env hint
    // when the walk missed (WI-002). The deeper provenance split (channels stay
    // verified-only) is locked in mcp/__tests__/senderProvenance.test.ts.
    expect(src).toMatch(/const senderPtyId = getTaskSenderPtyId\(\);\s*\n\s*if \(senderPtyId\) params\.senderPtyId = senderPtyId;/);
  });
});

describe('a2a.rpc — execute uses the resolved workspaceId', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'main', 'pipe', 'handlers', 'a2a.rpc.ts'),
    'utf-8',
  );
  it('reads toWorkspaceId from the renderer result instead of the raw fuzzy `to`', () => {
    // The resolved id is pulled off the renderer result and no raw params.to fallback
    // is used for worker execution.
    expect(src).toMatch(/toWorkspaceId/);
    expect(src).toMatch(/const receiverWsId = typeof record\?\.toWorkspaceId === 'string' \? record\.toWorkspaceId : ''/);
    expect(src).toMatch(/executeApproved/);
  });
});

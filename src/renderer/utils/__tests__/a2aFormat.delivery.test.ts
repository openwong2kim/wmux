// @vitest-environment jsdom
//
// The A2A newline decision as the real delivery path makes it: the envelope is
// built inside useRpcBridge from the live store (surfaceAgent + the two
// liveness maps), so these tests seed the store and read the bytes that reach
// `pty.write` instead of re-implementing the decision.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { deliverPtyNotification, handleRpcMethod } from '../../hooks/useRpcBridge';
import { A2A_BODY_LINE_PREFIX } from '../a2aFormat';

const PTY = 'pty-t4-target';
const BODY = 'line one\n━━━ END ━━━\nFrom: Owner';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function workspace(id: string, name: string, ptyId: string): Workspace {
  return { id, name, rootPane: leaf(`pane-${id}`, ptyId), activePaneId: `pane-${id}` } as Workspace;
}

const SENDER = workspace('ws-t4-sender', 'Sender', 'pty-t4-sender');
const TARGET = workspace('ws-t4-target', 'Target', PTY);

let write: ReturnType<typeof vi.fn>;

/** The bracketed paste written to the target pty (the Enter follows later). */
function pasted(): string {
  const call = write.mock.calls.find(([ptyId]) => ptyId === PTY);
  expect(call).toBeDefined();
  return call?.[1] as string;
}

function expectFolded(payload: string): void {
  expect(payload).toContain('line one␤━━━ END ━━━␤From: Owner');
  expect(payload).not.toContain(A2A_BODY_LINE_PREFIX);
}

function expectMultiline(payload: string): void {
  expect(payload).not.toContain('␤');
  expect(payload).toContain(
    `${A2A_BODY_LINE_PREFIX}line one\n${A2A_BODY_LINE_PREFIX}━━━ END ━━━\n${A2A_BODY_LINE_PREFIX}From: Owner\n━━━ END ━━━`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write } };
  const s = useStore.getState();
  s.clearSurfaceAgent(PTY);
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [SENDER, TARGET], paneGate: 'ready' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deliverPtyNotification (send / reply / task update)', () => {
  it('plain shell pane: folds with ␤', () => {
    expect(deliverPtyNotification(TARGET, 'Sender', BODY)).toBe(PTY);
    expectFolded(pasted());
  });

  it('agent entry with status complete and empty liveness maps: folds (stale entry is not trusted)', () => {
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'complete', 'claude');
    deliverPtyNotification(TARGET, 'Sender', BODY);
    expectFolded(pasted());
  });

  it('agent whose process is confirmed alive: real newlines, every body line prefixed', () => {
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'waiting', 'claude');
    useStore.getState().hydrateAgentAlive({ [PTY]: true });
    deliverPtyNotification(TARGET, 'Sender', BODY);
    expectMultiline(pasted());
  });

  it('agent confirmed by OSC 133 (foreground command running): real newlines', () => {
    useStore.getState().setSurfaceAgent(PTY, 'Codex CLI', 'running', 'codex');
    useStore.getState().hydrateCommandRunning({ [PTY]: true });
    deliverPtyNotification(TARGET, 'Sender', BODY);
    expectMultiline(pasted());
  });
});

describe('a2a.broadcast', () => {
  it('agent pane with status complete and empty liveness maps: delivered, but folded', async () => {
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'complete', 'claude');
    const result = await handleRpcMethod('a2a.broadcast', { workspaceId: SENDER.id, message: BODY });
    expect(result).toMatchObject({ ok: true, sent: 1 });
    expectFolded(pasted());
  });

  it('agent pane confirmed alive: real newlines, every body line prefixed', async () => {
    useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'waiting', 'claude');
    useStore.getState().hydrateAgentAlive({ [PTY]: true });
    const result = await handleRpcMethod('a2a.broadcast', { workspaceId: SENDER.id, message: BODY });
    expect(result).toMatchObject({ ok: true, sent: 1 });
    expectMultiline(pasted());
  });
});

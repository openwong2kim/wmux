// @vitest-environment jsdom
//
// #1342 — the remote resume chip's gates. The chip types a command into a pane
// on ANOTHER machine, so every input it reasons from is that machine's claim;
// these are the cases where it must refuse to render at all.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
const paneWrite = vi.fn();
(window as unknown as { electronAPI: unknown }).electronAPI = { remote: { paneWrite } };

import { useStore } from '../../../stores';
import type { RemotePaneSummary } from '../../../../shared/remoteHosts';
import RemoteResumeChip from '../RemoteResumeChip';

const HOST = 'h1';
const SESSION = 's1';
const resume = { agent: 'claude', sessionId: 'conv-1', cwdMatches: true } as const;

let container: HTMLDivElement;
let root: Root;

function setPane(pane: Partial<RemotePaneSummary>, stale = false): void {
  act(() => {
    useStore.setState((s) => {
      s.remoteWorkspaces = [{
        key: `${HOST}:ws1`,
        hostId: HOST,
        hostLabel: 'host',
        workspaceId: 'ws1',
        name: '',
        panes: [{ sessionId: SESSION, ...pane }],
        stale,
      }] as unknown as typeof s.remoteWorkspaces;
    });
  });
}

function render(props: { attachId?: string | null; readOnly?: boolean } = {}): string {
  act(() => {
    root.render(React.createElement(RemoteResumeChip, {
      hostId: HOST,
      sessionId: SESSION,
      attachId: props.attachId === undefined ? 'a1' : props.attachId,
      readOnly: props.readOnly ?? false,
    }));
  });
  return container.innerHTML;
}

beforeEach(() => {
  paneWrite.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('RemoteResumeChip gates (#1342)', () => {
  it('offers the chip when the host reports a settled agent', () => {
    setPane({ resume, commandRunning: false, agentProcessAlive: false });
    expect(render()).toContain('Resume');
  });

  // The authoritative gate, unchanged from the local chip: a foreground command
  // owns the PTY, so typing would land in the agent's input, not a shell.
  it('stays hidden while the host says a command is running', () => {
    setPane({ resume, commandRunning: true });
    expect(render()).toBe('');
  });

  // FAIL-CLOSED. A local pane that reports neither signal still has its own
  // output stamps and turn latch underneath; a remote pane has nothing, so
  // "no answer" must not be read as "not busy".
  it('stays hidden when the host answers neither liveness signal', () => {
    setPane({ resume });
    expect(render()).toBe('');
  });

  it('stays hidden on a read-only host, while re-attaching, and when stale', () => {
    setPane({ resume, commandRunning: false });
    expect(render({ readOnly: true })).toBe('');
    expect(render({ attachId: null })).toBe('');
    setPane({ resume, commandRunning: false }, true);
    expect(render()).toBe('');
  });
});

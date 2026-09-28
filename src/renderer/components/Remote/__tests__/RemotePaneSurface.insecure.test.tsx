// @vitest-environment jsdom
//
// A restored remote-terminal surface on a host that needs HTTPS: main refuses
// the attach itself (not a stream error a tick later, which the mirror would
// never hear), and the surface turns that into the needs-HTTPS notice with
// input shut — never a blank pane.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useStore } from '../../../stores';

const mirrorProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const chipProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../RemoteMirrorTerminal', () => ({
  default: (props: Record<string, unknown>) => { mirrorProps.push(props); return null; },
}));
vi.mock('../RemoteResumeChip', () => ({
  default: (props: Record<string, unknown>) => { chipProps.push(props); return null; },
}));

import RemotePaneSurface from '../RemotePaneSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let paneAttach: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mirrorProps.length = 0;
  chipProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  paneAttach = vi.fn(async () => ({
    ok: false,
    error: 'attach refused: this host needs HTTPS — re-pair over HTTPS',
    reason: 'insecure-transport',
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      hostsList: vi.fn(async () => [{ id: 'lan', label: 'lan-mac', origin: 'http://192.168.1.5:7681', addedAt: 1, allowInput: true }]),
      paneAttach,
      paneDetach: vi.fn(async () => undefined),
    },
  };
  act(() => {
    useStore.setState({
      remoteWorkspaces: [{ key: 'lan:ws', hostId: 'lan', hostLabel: 'lan-mac', workspaceId: 'ws', name: '', panes: [] }],
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => { useStore.setState({ remoteWorkspaces: [] }); });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('RemotePaneSurface on a host that needs HTTPS', () => {
  it('renders the needs-HTTPS state from the refused attach, shuts input, and flags the host', async () => {
    await act(async () => {
      root.render(<RemotePaneSurface hostId="lan" sessionId="s1" surfaceId="surf" onTitleChange={vi.fn()} />);
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(paneAttach).toHaveBeenCalledWith('lan', 's1');
    const last = mirrorProps[mirrorProps.length - 1];
    expect(last.insecureTransport).toBe(true);
    expect(last.attachId).toBeNull();
    expect(chipProps[chipProps.length - 1].readOnly).toBe(true);
    expect(useStore.getState().remoteWorkspaces[0].insecureTransport).toBe(true);
  });
});

// @vitest-environment jsdom
//
// A fresh remote tab shows the host's screen at once: the attach's meta (grid
// plus snapshot) can land before the mirror subscribes, so once the attachId
// has rendered the surface attaches again, main's idempotent path that sends a
// fresh meta and snapshot. A shadow workspace's tab keeps the user's font.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const mirrorProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../RemoteMirrorTerminal', () => ({
  default: (props: Record<string, unknown>) => { mirrorProps.push(props); return null; },
}));
vi.mock('../RemoteResumeChip', () => ({ default: () => null }));

import RemotePaneSurface from '../RemotePaneSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let paneAttach: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mirrorProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  paneAttach = vi.fn(async () => ({ ok: true, attachId: 'att-1' }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      hostsList: vi.fn(async () => []),
      paneAttach,
      paneDetach: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

describe('RemotePaneSurface replay on open', () => {
  it('attaches again once the mirror has the attachId, and only once', async () => {
    await act(async () => {
      root.render(<RemotePaneSurface hostId="h1" sessionId="s1" surfaceId="surf" onTitleChange={vi.fn()} />);
    });
    await settle();
    expect(mirrorProps[mirrorProps.length - 1].attachId).toBe('att-1');
    expect(paneAttach).toHaveBeenCalledTimes(2);
    expect(paneAttach).toHaveBeenNthCalledWith(2, 'h1', 's1');
    await act(async () => {
      root.render(<RemotePaneSurface hostId="h1" sessionId="s1" surfaceId="surf" onTitleChange={vi.fn()} isActive={false} />);
    });
    await settle();
    expect(paneAttach).toHaveBeenCalledTimes(2);
  });

  it('passes fixedFont through to the mirror', async () => {
    await act(async () => {
      root.render(<RemotePaneSurface hostId="h1" sessionId="s1" surfaceId="surf" onTitleChange={vi.fn()} fixedFont />);
    });
    await settle();
    expect(mirrorProps[mirrorProps.length - 1].fixedFont).toBe(true);
  });
});

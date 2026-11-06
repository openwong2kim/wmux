import { describe, expect, it, vi } from 'vitest';
import { FrameWorlds, evaluateInFrame, type CdpSend } from '../frameAccess';

// Cache behaviour of frame worlds against a fake CDP session. The real-Chrome
// behaviour is in frameAccess.chrome.runtime.test.ts.

function fakeCdp(tree: () => unknown, evaluate: (contextId: number) => unknown) {
  let nextContext = 10;
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Page.getFrameTree') return tree();
    if (method === 'Page.createIsolatedWorld') return { executionContextId: nextContext++ };
    if (method === 'Runtime.evaluate') return evaluate(params.contextId as number);
    return {};
  });
  return send;
}

const treeWith = (loaderId: string) => ({
  frameTree: { frame: { id: 'MAIN', loaderId: 'LM', url: 'https://top.test/' }, childFrames: [{ frame: { id: 'F1', loaderId, parentId: 'MAIN', url: 'https://top.test/f' } }] },
});
const count = (send: ReturnType<typeof fakeCdp>, method: string) => send.mock.calls.filter(([m]) => m === method).length;

describe('FrameWorlds', () => {
  it('reuses a cached world for the document the caller names without fetching the tree again', async () => {
    const send = fakeCdp(() => treeWith('L1'), () => ({ result: { value: 1 } }));
    const worlds = new FrameWorlds(send as unknown as CdpSend);
    for (let i = 0; i < 5; i++) await evaluateInFrame(send as unknown as CdpSend, worlds, 'F1', '1', 'L1');
    expect(count(send, 'Page.getFrameTree')).toBe(1);
    expect(count(send, 'Page.createIsolatedWorld')).toBe(1);
  });

  it('still refuses a navigated frame when its cached world has gone', async () => {
    let loader = 'L1';
    let live = 10;
    const send = fakeCdp(() => treeWith(loader), (contextId) => {
      if (contextId !== live) throw new Error('Cannot find context with specified id');
      return { result: { value: 1 } };
    });
    const worlds = new FrameWorlds(send as unknown as CdpSend);
    await evaluateInFrame(send as unknown as CdpSend, worlds, 'F1', '1', 'L1');
    loader = 'L2'; // the frame navigated: its old world is destroyed
    live = -1;
    await expect(evaluateInFrame(send as unknown as CdpSend, worlds, 'F1', '1', 'L1')).rejects.toThrow(/^FRAME_NAVIGATED/);
  });
});

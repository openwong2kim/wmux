// @vitest-environment jsdom
// A decision that lands at the top of Moa's one scrolling column while the
// operator reads the bottom of a long chat is out of view, and the titlebar
// stays quiet because the panel is open: the panel then names it above the
// composer, and the row scrolls back to it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWaitingOutOfView } from '../MoaTranscriptChat';

let observed: { cb: IntersectionObserverCallback; el: Element } | null = null;
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) { observed = { cb: this.cb, el }; }
  disconnect() { /* nothing to release */ }
}
const report = (visible: boolean) => act(() => observed!.cb([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver));

let host: HTMLDivElement;
let root: Root;
let result: ReturnType<typeof useWaitingOutOfView>;
function Probe({ decisions }: { decisions: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  result = useWaitingOutOfView(ref);
  return (
    <div ref={ref}>
      {decisions > 0 && <section data-moa-waiting>{Array.from({ length: decisions }, (_, i) => <div key={i} data-moa-decision />)}</section>}
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  observed = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Waiting on you out of view', () => {
  it('reports the decisions only while their section is scrolled away, and jumps back to it', async () => {
    await act(async () => root.render(<Probe decisions={2} />));
    expect(result.count).toBe(0);
    report(false);
    expect(result.count).toBe(2);
    const scroll = vi.fn();
    (observed!.el as HTMLElement).scrollIntoView = scroll;
    result.jump();
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    report(true);
    expect(result.count).toBe(0);
  });

  it('says nothing when there is no decision', async () => {
    await act(async () => root.render(<Probe decisions={0} />));
    expect(observed).toBeNull();
    expect(result.count).toBe(0);
  });
});

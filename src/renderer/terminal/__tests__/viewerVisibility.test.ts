import { describe, it, expect } from 'vitest';
import { decideViewerVisibility } from '../viewerVisibility';

const base = {
  paneVisible: true,
  docVisible: true,
  windowDisplayed: true,
  prevWindowVisible: true,
};

describe('decideViewerVisibility — what the daemon is told', () => {
  it('reports visible only when the pane AND both window terms agree', () => {
    expect(decideViewerVisibility(base).viewerVisible).toBe(true);
    expect(decideViewerVisibility({ ...base, paneVisible: false }).viewerVisible).toBe(false);
    expect(decideViewerVisibility({ ...base, docVisible: false }).viewerVisible).toBe(false);
    expect(decideViewerVisibility({ ...base, windowDisplayed: false }).viewerVisible).toBe(false);
  });

  it('#882 — a minimized window hides the pane even though docVisible stays true', () => {
    // This is the whole bug: on Windows `document.visibilityState` never
    // reports hidden, so without the windowDisplayed term the desk kept
    // claiming the size and the phone kept getting 409 desk-owns-size.
    const d = decideViewerVisibility({ ...base, docVisible: true, windowDisplayed: false });
    expect(d.windowVisible).toBe(false);
    expect(d.viewerVisible).toBe(false);
  });

  it('keeps docVisible load-bearing — occlusion on the platforms that report it', () => {
    const d = decideViewerVisibility({ ...base, docVisible: false, windowDisplayed: true });
    expect(d.viewerVisible).toBe(false);
  });
});

describe('decideViewerVisibility — retaking the geometry', () => {
  it('refits when the window comes back and this pane is on screen', () => {
    // A restored window fires no ResizeObserver tick (the container never
    // changed size), so without this the pane keeps whatever geometry the
    // phone gave it while the desk was away.
    const d = decideViewerVisibility({ ...base, prevWindowVisible: false });
    expect(d.refit).toBe(true);
  });

  it('#882 — a restore that only windowDisplayed can see still refits', () => {
    const d = decideViewerVisibility({
      paneVisible: true,
      docVisible: true,        // constant on Windows, before and after
      windowDisplayed: true,
      prevWindowVisible: false, // was minimized
    });
    expect(d.refit).toBe(true);
  });

  it('does not refit a pane that is not on screen', () => {
    const d = decideViewerVisibility({ ...base, paneVisible: false, prevWindowVisible: false });
    expect(d.refit).toBe(false);
  });

  it('does not refit while the window stays visible', () => {
    expect(decideViewerVisibility(base).refit).toBe(false);
  });

  it('does not refit on the way out', () => {
    const d = decideViewerVisibility({ ...base, windowDisplayed: false, prevWindowVisible: true });
    expect(d.refit).toBe(false);
  });

  it('keys the reveal on the window terms only, so a workspace switch does not double-fit', () => {
    // useTerminal's own visibility effect already refits on a workspace/tab
    // reveal; keying this on the combined value would fit twice.
    const d = decideViewerVisibility({ ...base, paneVisible: true, prevWindowVisible: true });
    expect(d.refit).toBe(false);
  });
});

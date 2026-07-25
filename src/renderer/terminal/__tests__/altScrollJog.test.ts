/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachAltScrollJog } from '../altScrollJog';

const PANE_HEIGHT = 400;
// RAIL_HEIGHT_RATIO 0.45 of 400 = 180, inside the 96..260 clamp. jsdom reports
// offsetHeight 0 for the grip, so half-travel is the full 90px.
const HALF_TRAVEL = 90;

let rafQueue: FrameRequestCallback[];
let now: number;

function flushFrames(frames: number, msPerFrame = 16): void {
  for (let i = 0; i < frames; i++) {
    const queued = rafQueue;
    rafQueue = [];
    now += msPerFrame;
    for (const cb of queued) cb(now);
  }
}

function makeHost() {
  const host = document.createElement('div');
  host.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  host.appendChild(screen);
  document.body.appendChild(host);
  Object.defineProperty(host, 'clientHeight', { value: PANE_HEIGHT, configurable: true });
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: PANE_HEIGHT, right: 800, bottom: PANE_HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { host, screen };
}

function makeTerminal(host: HTMLElement): Terminal {
  return { element: host } as unknown as Terminal;
}

function gripOf(host: HTMLElement): HTMLElement {
  const grip = host.querySelector('.fmux-jog-grip') as HTMLElement | null;
  if (!grip) throw new Error('grip not mounted');
  // jsdom does not implement pointer capture.
  grip.setPointerCapture = () => {};
  grip.releasePointerCapture = () => {};
  return grip;
}

// jsdom has no PointerEvent; the module only reads button/clientY/pointerId.
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId: number }) {
    super(type, init);
    this.pointerId = init.pointerId;
  }
}

function pointer(type: string, clientY: number): PointerEvent {
  return new FakePointerEvent(type, {
    clientY, button: 0, pointerId: 1, bubbles: true, cancelable: true,
  }) as unknown as PointerEvent;
}

/** Drag the grip `offset` px from centre and run `frames` animation frames. */
function dragAndRun(host: HTMLElement, offset: number, frames: number): void {
  const grip = gripOf(host);
  // The rail is centred on the pane, so its centre is the drag origin.
  const rail = host.querySelector('.fmux-jog-rail') as HTMLElement;
  rail.getBoundingClientRect = () =>
    ({ left: 0, top: 110, width: 10, height: 180, right: 10, bottom: 290, x: 0, y: 110, toJSON: () => ({}) }) as DOMRect;
  grip.dispatchEvent(pointer('pointerdown', 200));
  grip.dispatchEvent(pointer('pointermove', 200 + offset));
  flushFrames(frames);
}

describe('altScrollJog', () => {
  let wheelEvents: WheelEvent[];

  beforeEach(() => {
    rafQueue = [];
    now = 0;
    wheelEvents = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function listen(host: HTMLElement): void {
    host.addEventListener('wheel', (e) => wheelEvents.push(e as WheelEvent));
  }

  it('mounts nothing until enabled and cleans up when disabled', () => {
    const { host } = makeHost();
    const jog = attachAltScrollJog(makeTerminal(host), host);
    expect(host.querySelector('.fmux-jog-rail')).toBeNull();

    jog.setEnabled(true);
    expect(host.querySelector('.fmux-jog-rail')).not.toBeNull();
    expect(host.querySelector('.fmux-jog-grip')).not.toBeNull();

    jog.setEnabled(false);
    expect(host.querySelector('.fmux-jog-rail')).toBeNull();
    jog.dispose();
  });

  it('emits nothing while the grip rests at centre', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, 0, 10);
    expect(wheelEvents).toHaveLength(0);
    jog.dispose();
  });

  it('ignores displacement inside the dead zone', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    // DEAD_ZONE is 0.04 of half-travel; 3px of 90 is ~0.033. It only has to
    // absorb the jitter of grabbing the grip.
    dragAndRun(host, 3, 20);
    expect(wheelEvents).toHaveLength(0);
    jog.dispose();
  });

  it('responds promptly just past the dead zone, with no unresponsive band', () => {
    // The rate floor is what keeps the bottom of the range usable: a pure
    // quadratic approaches zero here, which reads as a far wider dead zone than
    // the threshold really is.
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    // 6px of 90 is ~0.067 — barely outside the dead zone.
    dragAndRun(host, 6, 12); // ~192ms at MIN_EVENTS_PER_SEC 6 => at least one
    expect(wheelEvents.length).toBeGreaterThan(0);
    jog.dispose();
  });

  it('scrolls down for downward displacement and up for upward', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);

    dragAndRun(host, HALF_TRAVEL, 10);
    expect(wheelEvents.length).toBeGreaterThan(0);
    expect(wheelEvents.every((e) => e.deltaY > 0)).toBe(true);
    gripOf(host).dispatchEvent(pointer('pointerup', 290));

    wheelEvents = [];
    dragAndRun(host, -HALF_TRAVEL, 10);
    expect(wheelEvents.length).toBeGreaterThan(0);
    expect(wheelEvents.every((e) => e.deltaY < 0)).toBe(true);
    jog.dispose();
  });

  it('emits line-mode deltas of exactly one, so each event is one report', () => {
    // xterm turns one wheel event into exactly one mouse report, and
    // consumeWheelEvent returns deltaY unchanged only in DOM_DELTA_LINE mode —
    // pixel mode would be damped by its trackpad heuristic and accumulator.
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, HALF_TRAVEL, 6);

    expect(wheelEvents.length).toBeGreaterThan(0);
    for (const event of wheelEvents) {
      expect(Math.abs(event.deltaY)).toBe(1);
      expect(event.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    }
    jog.dispose();
  });

  it('reports from inside the screen grid, not the rail at the edge', () => {
    // xterm drops a wheel whose coordinates fall outside .xterm-screen.
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, HALF_TRAVEL, 6);

    expect(wheelEvents.length).toBeGreaterThan(0);
    expect(wheelEvents[0].clientX).toBe(400);
    expect(wheelEvents[0].clientY).toBe(200);
    jog.dispose();
  });

  it('scrolls faster the further the grip is dragged', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);

    dragAndRun(host, Math.round(HALF_TRAVEL * 0.45), 12);
    const nearCentre = wheelEvents.length;
    gripOf(host).dispatchEvent(pointer('pointerup', 240));

    wheelEvents = [];
    dragAndRun(host, HALF_TRAVEL, 12);
    const fullThrow = wheelEvents.length;

    expect(nearCentre).toBeGreaterThan(0);
    expect(fullThrow).toBeGreaterThan(nearCentre);
    jog.dispose();
  });

  it('caps emissions per frame so a slow app cannot be flooded', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);

    const grip = gripOf(host);
    const rail = host.querySelector('.fmux-jog-rail') as HTMLElement;
    rail.getBoundingClientRect = () =>
      ({ left: 0, top: 110, width: 10, height: 180, right: 10, bottom: 290, x: 0, y: 110, toJSON: () => ({}) }) as DOMRect;
    grip.dispatchEvent(pointer('pointerdown', 200));
    grip.dispatchEvent(pointer('pointermove', 200 + HALF_TRAVEL));
    // The first frame after pointerdown always has dt 0 (lastFrameTime is
    // seeded there), so it can never accrue credit — the cap only binds from
    // the second frame on. Two long frames each clamp dt to 100ms, which at
    // MAX_EVENTS_PER_SEC 110 is ~11 events' worth of credit apiece.
    flushFrames(2, 5000);
    expect(wheelEvents.length).toBeGreaterThan(0);
    expect(wheelEvents.length).toBeLessThanOrEqual(6);
    jog.dispose();
  });

  it('ends the drag when pointer capture is lost without a pointerup', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, HALF_TRAVEL, 4);
    expect(wheelEvents.length).toBeGreaterThan(0);

    // Capture stolen (native drag/menu) — no pointerup ever reaches the grip.
    gripOf(host).dispatchEvent(new Event('lostpointercapture'));
    wheelEvents = [];
    flushFrames(20);
    expect(wheelEvents).toHaveLength(0);
    jog.dispose();
  });

  it('ends the drag on a release that never reaches the grip', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, HALF_TRAVEL, 4);
    expect(wheelEvents.length).toBeGreaterThan(0);

    // Without capture the release lands on whatever is under the pointer.
    window.dispatchEvent(pointer('pointerup', 900));
    wheelEvents = [];
    flushFrames(20);
    expect(wheelEvents).toHaveLength(0);
    jog.dispose();
  });

  it('springs back to centre and stops scrolling on release', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);

    dragAndRun(host, HALF_TRAVEL, 8);
    expect(wheelEvents.length).toBeGreaterThan(0);

    const grip = gripOf(host);
    grip.dispatchEvent(pointer('pointerup', 290));
    expect(grip.style.transform).toContain('translate3d(0, 0.0px, 0)');

    wheelEvents = [];
    flushFrames(20);
    expect(wheelEvents).toHaveLength(0);
    jog.dispose();
  });

  it('stops scrolling and unmounts on dispose mid-drag', () => {
    const { host } = makeHost();
    listen(host);
    const jog = attachAltScrollJog(makeTerminal(host), host);
    jog.setEnabled(true);
    dragAndRun(host, HALF_TRAVEL, 4);
    expect(wheelEvents.length).toBeGreaterThan(0);

    jog.dispose();
    wheelEvents = [];
    flushFrames(20);
    expect(wheelEvents).toHaveLength(0);
    expect(host.querySelector('.fmux-jog-rail')).toBeNull();
  });
});

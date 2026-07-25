import type { Terminal } from '@xterm/xterm';

// fmux#13 — scroll control for panes on the alternate buffer.
//
// On the alternate buffer xterm holds no scrollback, so it cannot answer either
// question a scrollbar exists to answer: how tall is the content, and where am
// I in it. No terminal protocol lets a hosted app report its scroll offset, so
// a slider here could only ever be decorative — that is precisely how #13
// manifested. What xterm *can* do is forward scroll intent to the app, which is
// why the wheel keeps working in a full-screen TUI.
//
// So this is deliberately not a scrollbar. It is a spring-centred jog control:
// displacement from the rail's centre sets a scroll *rate*, release returns to
// centre and stops. It claims no knowledge of position because it has none.
//
// Scroll intent is delivered by dispatching a synthetic `wheel` event at
// terminal.element rather than by encoding escape sequences here. xterm's own
// handler then does the right thing for whichever mode the app negotiated:
//   - app requested wheel reporting (Claude Code: protocol ANY, encoding SGR)
//     -> a correctly encoded mouse report
//   - no mouse tracking and no scrollback (vim, less)
//     -> a cursor up/down sequence
// One dispatched event yields exactly one report, so rate is expressed as
// events per second. deltaMode is DOM_DELTA_LINE with deltaY ±1 so that
// CoreMouseService.consumeWheelEvent returns ±1 directly, bypassing its
// pixel-mode trackpad damping and fractional accumulator.

/** Rail travel is this fraction of pane height, within the px bounds below. */
const RAIL_HEIGHT_RATIO = 0.45;
const RAIL_MIN_PX = 96;
const RAIL_MAX_PX = 260;
// Displacement below this fraction of half-travel does not scroll. Kept small:
// it only needs to absorb the jitter of grabbing the grip, and every pixel
// spent here is a pixel taken away from the usable rate range.
const DEAD_ZONE = 0.04;
// Rate at the first pixel past the dead zone. Without a floor the response
// curve below approaches zero there, which reads as a much wider dead zone than
// the threshold actually is — slow, but unmistakably moving, is what makes the
// bottom of the range usable.
const MIN_EVENTS_PER_SEC = 6;
/** Events per second at full deflection. A wheel tick is ~3 lines by comparison. */
const MAX_EVENTS_PER_SEC = 110;
/** >1 biases travel toward fine control near centre. */
const RATE_CURVE_EXPONENT = 2;
/** Never emit more than this per frame, so a slow app cannot be flooded. */
const MAX_EVENTS_PER_FRAME = 6;

export interface AltScrollJog {
  /** Recompute rail geometry (call after a resize/fit). */
  refresh(): void;
  /** Show or hide the control. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

function emitScrollEvent(terminal: Terminal, direction: -1 | 1): void {
  const element = terminal.element;
  const screen = element?.querySelector('.xterm-screen') as HTMLElement | null;
  if (!element || !screen) return;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  // xterm resolves the report's cell from these coordinates and drops the event
  // if they fall outside the screen element. The rail sits over the right edge,
  // so report from the screen's centre instead — that is the content region a
  // TUI expects a wheel over, and it keeps the report inside the grid.
  element.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY: direction,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function attachAltScrollJog(terminal: Terminal, host: HTMLElement): AltScrollJog {
  let disposed = false;
  let enabled = false;
  let dragging = false;
  let pointerId: number | null = null;
  let railHalfTravel = 0;
  let displacement = 0;
  let dragOrigin = 0;
  let frame: number | null = null;
  let lastFrameTime = 0;
  let eventCredit = 0;

  const rail = document.createElement('div');
  rail.className = 'fmux-jog-rail';
  rail.setAttribute('aria-hidden', 'true');
  const grip = document.createElement('div');
  grip.className = 'fmux-jog-grip';
  grip.title = 'Drag to scroll — further from centre scrolls faster';
  rail.appendChild(grip);

  const measure = (): void => {
    const height = host.clientHeight;
    if (height <= 0) return;
    const railHeight = Math.round(
      Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, height * RAIL_HEIGHT_RATIO)),
    );
    rail.style.height = `${railHeight}px`;
    // Half the distance the grip may travel from the rail's centre.
    railHalfTravel = Math.max(1, (railHeight - grip.offsetHeight) / 2);
  };

  const paint = (): void => {
    grip.style.transform = `translate3d(0, ${displacement.toFixed(1)}px, 0)`;
  };

  const stopFrames = (): void => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    eventCredit = 0;
  };

  const tick = (now: number): void => {
    frame = null;
    if (disposed || !dragging) return;
    const dt = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0;
    lastFrameTime = now;

    const normalized = Math.max(-1, Math.min(1, displacement / railHalfTravel));
    const magnitude = Math.abs(normalized);
    if (magnitude > DEAD_ZONE) {
      // Re-map past the dead zone so the whole remaining travel is usable, then
      // curve it between a floor and the max: fine control near centre, long
      // throws for fast travel, and never an unresponsive band above the
      // threshold.
      const scaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
      const rate =
        MIN_EVENTS_PER_SEC
        + (MAX_EVENTS_PER_SEC - MIN_EVENTS_PER_SEC) * Math.pow(scaled, RATE_CURVE_EXPONENT);
      eventCredit += rate * dt;
      const count = Math.min(MAX_EVENTS_PER_FRAME, Math.floor(eventCredit));
      if (count > 0) {
        eventCredit -= count;
        const direction = normalized < 0 ? -1 : 1;
        for (let i = 0; i < count; i++) emitScrollEvent(terminal, direction);
      }
    } else {
      eventCredit = 0;
    }
    frame = requestAnimationFrame(tick);
  };

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    if (pointerId !== null) {
      try {
        grip.releasePointerCapture(pointerId);
      } catch {
        // capture may already be gone (pointercancel, element detached)
      }
      pointerId = null;
    }
    stopFrames();
    displacement = 0; // spring back to centre
    grip.classList.remove('is-dragging');
    paint();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !enabled) return;
    event.preventDefault();
    event.stopPropagation();
    measure();
    dragging = true;
    pointerId = event.pointerId;
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // capture is an optimisation (keeps the drag alive outside the grip);
      // the pointerup/pointercancel handlers still end the drag without it.
    }
    grip.classList.add('is-dragging');
    const railRect = rail.getBoundingClientRect();
    dragOrigin = railRect.top + railRect.height / 2;
    displacement = 0;
    lastFrameTime = 0;
    eventCredit = 0;
    paint();
    frame = requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    displacement = Math.max(
      -railHalfTravel,
      Math.min(railHalfTravel, event.clientY - dragOrigin),
    );
    paint();
  };

  grip.addEventListener('pointerdown', onPointerDown);
  grip.addEventListener('pointermove', onPointerMove);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  return {
    refresh: measure,
    setEnabled(next: boolean): void {
      if (disposed || next === enabled) return;
      enabled = next;
      if (next) {
        host.appendChild(rail);
        measure();
        paint();
      } else {
        endDrag();
        rail.remove();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      endDrag();
      grip.removeEventListener('pointerdown', onPointerDown);
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', endDrag);
      grip.removeEventListener('pointercancel', endDrag);
      rail.remove();
    },
  };
}

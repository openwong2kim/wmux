import { describe, it, expect, vi } from 'vitest';
import { createMouseOwnedHint } from '../mouseOwnedHint';

function harness(opts?: { owned?: boolean; cooldownMs?: number; mac?: boolean }) {
  const show = vi.fn();
  let owned = opts?.owned ?? true;
  let clock = 0;
  const hint = createMouseOwnedHint({
    isMouseOwned: () => owned,
    show,
    now: () => clock,
    cooldownMs: opts?.cooldownMs ?? 20_000,
    dragThresholdPx: 8,
    // xterm's shouldForceSelection: altKey on macOS, shiftKey everywhere else.
    forcesSelection: opts?.mac ? (e) => e.altKey === true : (e) => e.shiftKey,
  });
  return {
    show,
    hint,
    setOwned: (v: boolean) => { owned = v; },
    advance: (ms: number) => { clock += ms; },
    drag: (dx: number, dy = 0, mods?: { button?: number; shiftKey?: boolean; altKey?: boolean }) => {
      hint.onMouseDown({ button: mods?.button ?? 0, shiftKey: mods?.shiftKey ?? false, altKey: mods?.altKey ?? false, clientX: 100, clientY: 100 });
      hint.onMouseMove({ clientX: 100 + dx, clientY: 100 + dy });
      hint.onMouseUp();
    },
  };
}

describe('createMouseOwnedHint', () => {
  it('hints when a left-drag is attempted while the app owns the mouse', () => {
    const h = harness();
    h.drag(40);
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the app does not own the mouse — selection works there', () => {
    const h = harness({ owned: false });
    h.drag(40);
    expect(h.show).not.toHaveBeenCalled();
  });

  it('stays silent when Shift is held — that gesture already selects', () => {
    const h = harness();
    h.drag(40, 0, { shiftKey: true });
    expect(h.show).not.toHaveBeenCalled();
  });

  // #1437 + the macOS half of it: on macOS xterm forces the selection on Option,
  // not Shift, so the escape modifier — and therefore what is worth saying — is
  // the other one. Telling a Mac user to hold Shift sends them to a key that
  // does nothing, and nagging on the Option+drag that DID select is worse.
  it('on macOS: stays silent for Option+drag, still hints on Shift+drag', () => {
    const mac = harness({ mac: true });
    mac.drag(40, 0, { altKey: true });
    expect(mac.show).not.toHaveBeenCalled();
    mac.drag(40, 0, { shiftKey: true });
    expect(mac.show).toHaveBeenCalledTimes(1);
  });

  it('stays silent for the right button — right-click has its own Shift-aware path', () => {
    const h = harness();
    h.drag(40, 0, { button: 2 });
    expect(h.show).not.toHaveBeenCalled();
  });

  it('stays silent for a bare click and for sub-threshold jitter', () => {
    const h = harness();
    h.hint.onMouseDown({ button: 0, shiftKey: false, clientX: 100, clientY: 100 });
    h.hint.onMouseUp();
    h.drag(3, 3);
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does not fire twice within one drag', () => {
    const h = harness();
    h.hint.onMouseDown({ button: 0, shiftKey: false, clientX: 100, clientY: 100 });
    h.hint.onMouseMove({ clientX: 140, clientY: 100 });
    h.hint.onMouseMove({ clientX: 180, clientY: 100 });
    h.hint.onMouseMove({ clientX: 220, clientY: 100 });
    h.hint.onMouseUp();
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it('rate-limits repeat drags, then hints again after the cooldown', () => {
    const h = harness({ cooldownMs: 20_000 });
    h.drag(40);
    h.advance(19_999);
    h.drag(40);
    expect(h.show).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.drag(40);
    expect(h.show).toHaveBeenCalledTimes(2);
  });

  it('re-reads mouse ownership on every mousedown', () => {
    const h = harness({ owned: false });
    h.drag(40);
    expect(h.show).not.toHaveBeenCalled();
    h.setOwned(true);
    h.drag(40);
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it('a mouseup between press and move cancels the pending drag', () => {
    const h = harness();
    h.hint.onMouseDown({ button: 0, shiftKey: false, clientX: 100, clientY: 100 });
    h.hint.onMouseUp();
    h.hint.onMouseMove({ clientX: 200, clientY: 100 });
    expect(h.show).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Dynamic test for the fan-out dialog's skip-permissions checkbox and launch
// command preview. Mounts the real <FanOutDialog/> and drives the checkbox /
// agent command field, asserting the preview stays WYSIWYG with what the task
// pane would launch. The packaged Electron UI can't be automated, so this jsdom
// harness is the verification surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import FanOutDialog from '../FanOutDialog';
import { SKIP_PERMISSIONS_FLAG } from '../fanoutAgentCmd';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(FanOutDialog, { onClose: vi.fn() })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = <T extends HTMLElement>(id: string): T | null => container.querySelector(`[data-testid="${id}"]`);
const preview = (): string => q('fanout-command-preview')?.textContent ?? '';

/** React tracks input value natively — set it through the prototype setter. */
function typeAgentCmd(value: string): void {
  const input = q<HTMLInputElement>('fanout-agent') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FanOutDialog — skip permissions', () => {
  it('starts on the default claude command with the flag off', () => {
    const box = q<HTMLInputElement>('fanout-skip-permissions');
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
    expect(preview()).toBe('claude');
  });

  it('checking the box appends the flag to the launch command', () => {
    const box = q<HTMLInputElement>('fanout-skip-permissions') as HTMLInputElement;
    act(() => {
      box.click();
    });
    expect(preview()).toBe(`claude ${SKIP_PERMISSIONS_FLAG}`);
    expect(q<HTMLInputElement>('fanout-skip-permissions')?.checked).toBe(true);
    // ...and unchecking strips it again.
    act(() => {
      (q<HTMLInputElement>('fanout-skip-permissions') as HTMLInputElement).click();
    });
    expect(preview()).toBe('claude');
  });

  it('typing the flag by hand ticks the box (the command is the source of truth)', () => {
    typeAgentCmd(`claude ${SKIP_PERMISSIONS_FLAG} --model haiku`);
    expect(q<HTMLInputElement>('fanout-skip-permissions')?.checked).toBe(true);
    expect(preview()).toBe(`claude ${SKIP_PERMISSIONS_FLAG} --model haiku`);
  });

  it('hides the box for a non-claude launcher and points the user at their own flag', () => {
    typeAgentCmd('codex');
    expect(q('fanout-skip-permissions')).toBeNull();
    expect(q('fanout-skip-permissions-unsupported')).not.toBeNull();
    expect(preview()).toBe('codex');
  });

  it('toggles from an empty field, where the preview already reads claude', () => {
    typeAgentCmd('');
    expect(preview()).toBe('claude');
    act(() => {
      (q<HTMLInputElement>('fanout-skip-permissions') as HTMLInputElement).click();
    });
    expect(preview()).toBe(`claude ${SKIP_PERMISSIONS_FLAG}`);
  });

  it('offers to strip a claude-only flag left behind on another launcher', () => {
    typeAgentCmd(`codex ${SKIP_PERMISSIONS_FLAG}`);
    expect(q('fanout-skip-permissions-stale')).not.toBeNull();
    act(() => {
      (q<HTMLButtonElement>('fanout-skip-permissions-strip') as HTMLButtonElement).click();
    });
    expect(preview()).toBe('codex');
    expect(q('fanout-skip-permissions-stale')).toBeNull();
  });
});

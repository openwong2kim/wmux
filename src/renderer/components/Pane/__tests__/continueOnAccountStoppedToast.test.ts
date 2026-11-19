// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { stoppedNotRelaunchedToast } from '../usePaneContinueOnAccount';
import ToastContainer from '../../Toast/ToastContainer';
import { useStore } from '../../../stores';
import { t } from '../../../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINE = "cd -- '/work' && CLAUDE_CONFIG_DIR='/acc/b' claude --resume 0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
// A PowerShell resume line of about 300 characters, with a long unbroken path.
const PWSH = `if (Set-Location -LiteralPath 'C:\\Users\\someone\\source\\repos\\${'a-very-long-project-folder-name-'.repeat(2)}x' -PassThru -ErrorAction SilentlyContinue) { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\someone\\.wmux\\accounts\\claude-work-account-2'; claude --resume 0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d --dangerously-skip-permissions }`;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  act(() => useStore.setState({ toasts: [] } as never));
  vi.unstubAllGlobals();
});

// #3437: Claude stopped and its conversation was copied, but it was not
// relaunched. The toast says why and gives the line that resumes the copy.
describe('the toast for a relaunch blocked after the stop', () => {
  it('names the reason, carries the resume line, stays until dismissed, and copies the line', () => {
    const toast = stoppedNotRelaunchedToast('shell_typed', LINE, 'Work', t);
    expect(toast.level).toBe('error');
    expect(toast.persist).toBe(true);
    expect(toast.message).toContain('something was typed in the pane');
    expect(toast.message).toContain('Work');
    expect(toast.code).toBe(LINE);

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    toast.action?.onClick();
    expect(writeText).toHaveBeenCalledWith(LINE);
  });

  it('gives each reason its own wording, and a plain one for any other', () => {
    expect(stoppedNotRelaunchedToast('shell_busy', LINE, 'Work', t).message).toContain('did not return to an empty prompt');
    expect(stoppedNotRelaunchedToast('shell_running', LINE, 'Work', t).message).toContain('a program is still running');
    expect(stoppedNotRelaunchedToast('save_failed', LINE, 'Work', t).message).toContain('could not be saved');
    const other = stoppedNotRelaunchedToast('unknown_session', LINE, 'Work', t);
    expect(other.message).toContain('was not relaunched');
    expect(other.code).toBe(LINE);
  });

  it('draws a long PowerShell line as a mono block that wraps anywhere, and copies it whole', async () => {
    expect(PWSH.length).toBeGreaterThanOrEqual(290);
    act(() => { useStore.getState().pushToast(stoppedNotRelaunchedToast('shell_busy', PWSH, 'Work', t)); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(createElement(ToastContainer)); });

    const block = host.querySelector('[data-toast-code]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.classList.contains('ui-code')).toBe(true);
    expect(block.style.overflowWrap).toBe('anywhere');
    expect(block.textContent).toBe(PWSH);

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copy = [...host.querySelectorAll('button')].find((b) => b.textContent === t('resume.copyCommand'));
    await act(async () => { copy?.click(); });
    expect(writeText).toHaveBeenCalledWith(PWSH);
  });
});

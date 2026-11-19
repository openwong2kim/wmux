import { describe, expect, it, vi } from 'vitest';
import { stoppedNotRelaunchedToast } from '../usePaneContinueOnAccount';
import { t } from '../../../i18n';

const LINE = "cd -- '/work' && CLAUDE_CONFIG_DIR='/acc/b' claude --resume 0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";

// #3437: Claude stopped and its conversation was copied, but it was not
// relaunched. The toast says why and gives the line that resumes the copy.
describe('the toast for a relaunch blocked after the stop', () => {
  it('names the reason and the resume line, stays until dismissed, and copies the line', () => {
    const toast = stoppedNotRelaunchedToast('shell_typed', LINE, 'Work', t);
    expect(toast.level).toBe('error');
    expect(toast.persist).toBe(true);
    expect(toast.message).toContain('something was typed in the pane');
    expect(toast.message).toContain('Work');
    expect(toast.message).toContain(LINE);

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      toast.action?.onClick();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(writeText).toHaveBeenCalledWith(LINE);
  });

  it('gives each reason its own wording, and a plain one for any other', () => {
    expect(stoppedNotRelaunchedToast('shell_busy', LINE, 'Work', t).message).toContain('did not return to an empty prompt');
    expect(stoppedNotRelaunchedToast('shell_running', LINE, 'Work', t).message).toContain('a program is still running');
    expect(stoppedNotRelaunchedToast('save_failed', LINE, 'Work', t).message).toContain('could not be saved');
    const other = stoppedNotRelaunchedToast('unknown_session', LINE, 'Work', t).message;
    expect(other).toContain('was not relaunched');
    expect(other).toContain(LINE);
  });
});

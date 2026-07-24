// The statusline script is invoked by Claude Code as a bare `node` command, so
// the only honest way to test it is the same way: spawn it and feed the JSON
// Claude Code actually pipes on stdin.
//
// These cases exist because the model label had no tests at all and quietly
// drifted from the stdin contract: Claude Code used to bake a " (1M context)"
// suffix into `model.display_name` and ≥2.1.218 moved the window size into
// `context_window.context_window_size` instead. The label deliberately renders
// neither — model plus effort, nothing else — so what these lock down is that
// the window never leaks into the label from EITHER source, on either version.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../bin/wmux-statusline.mjs', import.meta.url));

/** A throwaway HOME so the account label resolves to a deterministic 'default'
 *  instead of reading the developer's real ~/.claude.json. */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-statusline-render-'));

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

function render(input: Record<string, unknown>): string {
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    // Hard cap so a regression that leaves the script waiting on stdin EOF
    // fails the test instead of hanging the whole run / CI.
    timeout: 10_000,
    env: {
      ...process.env,
      USERPROFILE: FAKE_HOME,
      HOME: FAKE_HOME,
      CLAUDE_CONFIG_DIR: '',
    },
  });
}

/** The model label is the first ` · `-separated field. */
function modelLabel(input: Record<string, unknown>): string {
  return render(input).split(' · ')[0];
}

describe('statusline model label', () => {
  it('renders model and effort only — no window size on a 1M session', () => {
    expect(
      modelLabel({
        model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
        effort: { level: 'xhigh' },
        context_window: { context_window_size: 1_000_000, used_percentage: 10 },
      }),
    ).toBe('Opus 4.8 (xhigh)');
  });

  it('renders identically on a standard 200k session', () => {
    expect(
      modelLabel({
        model: { display_name: 'Opus 4.8' },
        effort: { level: 'high' },
        context_window: { context_window_size: 200_000, used_percentage: 4 },
      }),
    ).toBe('Opus 4.8 (high)');
  });

  it('strips the legacy " (1M context)" suffix older Claude Code baked into the name', () => {
    expect(modelLabel({ model: { display_name: 'Opus 4.7 (1M context)' } })).toBe('Opus 4.7');
  });

  it('keeps the effort parenthetical clean when the legacy suffix is present', () => {
    expect(
      modelLabel({
        model: { display_name: 'Opus 4.7 (1M context)' },
        effort: { level: 'high' },
      }),
    ).toBe('Opus 4.7 (high)');
  });

  it('does not label an even larger window either', () => {
    expect(
      modelLabel({
        model: { display_name: 'Opus 5' },
        context_window: { context_window_size: 2_000_000 },
      }),
    ).toBe('Opus 5');
  });

  it('omits the parenthetical entirely on models that expose no effort', () => {
    expect(
      modelLabel({
        model: { display_name: 'Haiku 4.5' },
        context_window: { context_window_size: 200_000 },
      }),
    ).toBe('Haiku 4.5');
  });

  it('survives a malformed context_window without dropping the model', () => {
    expect(
      modelLabel({
        model: { display_name: 'Opus 4.8' },
        effort: { level: 'high' },
        context_window: { context_window_size: 'huge' },
      }),
    ).toBe('Opus 4.8 (high)');
  });
});

describe('statusline line assembly', () => {
  it('renders account, context fill, and both rate-limit windows', () => {
    const out = render({
      model: { display_name: 'Opus 4.8' },
      effort: { level: 'high' },
      context_window: { context_window_size: 1_000_000, used_percentage: 10 },
      rate_limits: {
        five_hour: { used_percentage: 11 },
        seven_day: { used_percentage: 97 },
      },
    });
    expect(out).toBe('Opus 4.8 (high) · default · ctx 10% · 5h 11% · 7d 97%');
  });

  it('shows `usage —` before the first response delivers rate_limits', () => {
    const out = render({ model: { display_name: 'Opus 4.8' } });
    expect(out).toBe('Opus 4.8 · default · usage —');
  });
});

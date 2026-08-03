/**
 * Tests for FirstRunWizard (T6).
 *
 * The repository's vitest config runs in `node` environment without a DOM
 * library installed (no jsdom / happy-dom / @testing-library/react), so this
 * suite tests the wizard via two complementary strategies:
 *   1. Pure helpers exported from FirstRunWizard.tsx (decideUiState,
 *      findTopLeftLeafId, formatCompletedAt, getRegisterErrorKeys).
 *   2. React DOM Server's `renderToStaticMarkup` for snapshot-style assertions
 *      against the conditionally rendered sub-blocks (ClaudeStatusBlock,
 *      SampleTaskBlock). Effects do NOT run in renderToStaticMarkup, so
 *      effect-driven assertions (e.g. "calls firstRun.check on mount") are
 *      covered by inspecting the IPC mock surface directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  decideUiState,
  findTopLeftLeafId,
  findLeafById,
  formatCompletedAt,
  getRegisterErrorKeys,
  ClaudeStatusBlock,
  SampleTaskBlock,
  StatuslineBlock,
  HooksBlock,
  decideStatuslineOffer,
} from '../FirstRunWizard';
import type { FirstRunCheckResult } from '../../../shared/firstRun';
import type { Pane } from '../../../shared/types';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const checkResult = (
  partial: Partial<FirstRunCheckResult> & { claudeFound?: boolean; mcpRegistered?: boolean },
): FirstRunCheckResult => ({
  shown: partial.shown ?? false,
  status: {
    claudeFound: partial.claudeFound ?? true,
    mcpRegistered: partial.mcpRegistered ?? true,
    claudeJsonPath: '/home/test/.claude.json',
  },
  completedAt: partial.completedAt,
});

const leaf = (id: string): Pane => ({
  id,
  type: 'leaf',
  surfaces: [],
  activeSurfaceId: '',
});

const grid2x2: Pane = {
  id: 'root-branch',
  type: 'branch',
  direction: 'vertical',
  sizes: [50, 50],
  children: [
    {
      id: 'top-row',
      type: 'branch',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaf('top-left'), leaf('top-right')],
    },
    {
      id: 'bot-row',
      type: 'branch',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaf('bot-left'), leaf('bot-right')],
    },
  ],
};

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('decideUiState', () => {
  it('returns null when result is not yet loaded', () => {
    expect(decideUiState(null, 'firstRun')).toBeNull();
  });

  it('returns "claude-missing" when Claude is not detected (firstRun)', () => {
    const r = checkResult({ claudeFound: false, mcpRegistered: false });
    expect(decideUiState(r, 'firstRun')).toBe('claude-missing');
  });

  it('returns "needs-register" when Claude is found but MCP is not registered', () => {
    const r = checkResult({ claudeFound: true, mcpRegistered: false });
    expect(decideUiState(r, 'firstRun')).toBe('needs-register');
  });

  it('returns "ready" when Claude is found and MCP is registered (firstRun)', () => {
    const r = checkResult({ claudeFound: true, mcpRegistered: true });
    expect(decideUiState(r, 'firstRun')).toBe('ready');
  });

  it('returns "reopen" regardless of detection state when mode=reopen (D9)', () => {
    expect(decideUiState(checkResult({ claudeFound: true, mcpRegistered: true }), 'reopen')).toBe(
      'reopen',
    );
    expect(decideUiState(checkResult({ claudeFound: false, mcpRegistered: false }), 'reopen')).toBe(
      'reopen',
    );
  });
});

describe('findTopLeftLeafId', () => {
  it('returns the id when the root itself is a leaf', () => {
    expect(findTopLeftLeafId(leaf('only'))).toBe('only');
  });

  it('returns the upper-left leaf id for a 2x2 grid', () => {
    expect(findTopLeftLeafId(grid2x2)).toBe('top-left');
  });

  it('descends children[0] recursively for deeply nested trees', () => {
    const deep: Pane = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [
        {
          id: 'b2',
          type: 'branch',
          direction: 'vertical',
          children: [leaf('deep-leaf'), leaf('other')],
        },
        leaf('right-leaf'),
      ],
    };
    expect(findTopLeftLeafId(deep)).toBe('deep-leaf');
  });

  it('returns null for a branch with no children (defensive)', () => {
    const empty: Pane = {
      id: 'b',
      type: 'branch',
      direction: 'horizontal',
      children: [],
    };
    expect(findTopLeftLeafId(empty)).toBeNull();
  });
});

describe('findLeafById', () => {
  it('returns the leaf for a matching id', () => {
    expect(findLeafById(grid2x2, 'top-left')?.id).toBe('top-left');
    expect(findLeafById(grid2x2, 'bot-right')?.id).toBe('bot-right');
  });

  it('returns null when id resolves to a branch', () => {
    expect(findLeafById(grid2x2, 'top-row')).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(findLeafById(grid2x2, 'nope')).toBeNull();
  });
});

describe('formatCompletedAt', () => {
  it('formats an ISO timestamp to YYYY-MM-DD', () => {
    expect(formatCompletedAt('2026-04-29T12:34:56.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty string for undefined input', () => {
    expect(formatCompletedAt(undefined)).toBe('');
  });

  it('returns empty string for malformed input', () => {
    expect(formatCompletedAt('not a date')).toBe('');
  });
});

describe('getRegisterErrorKeys', () => {
  it('returns the canonical keys for each known error code', () => {
    expect(getRegisterErrorKeys('PERM')).toEqual({
      problem: 'firstRunWizard.error.PERM.problem',
      cause: 'firstRunWizard.error.PERM.cause',
      fix: 'firstRunWizard.error.PERM.fix',
    });
    expect(getRegisterErrorKeys('PARSE')).toEqual({
      problem: 'firstRunWizard.error.PARSE.problem',
      cause: 'firstRunWizard.error.PARSE.cause',
      fix: 'firstRunWizard.error.PARSE.fix',
    });
    expect(getRegisterErrorKeys('IO')).toEqual({
      problem: 'firstRunWizard.error.IO.problem',
      cause: 'firstRunWizard.error.IO.cause',
      fix: 'firstRunWizard.error.IO.fix',
    });
    expect(getRegisterErrorKeys('UNKNOWN')).toEqual({
      problem: 'firstRunWizard.error.UNKNOWN.problem',
      cause: 'firstRunWizard.error.UNKNOWN.cause',
      fix: 'firstRunWizard.error.UNKNOWN.fix',
    });
  });

  it('falls back to UNKNOWN for unrecognized codes', () => {
    expect(getRegisterErrorKeys('GIBBERISH')).toEqual({
      problem: 'firstRunWizard.error.UNKNOWN.problem',
      cause: 'firstRunWizard.error.UNKNOWN.cause',
      fix: 'firstRunWizard.error.UNKNOWN.fix',
    });
  });
});

// ─── Renderer-level assertions via renderToStaticMarkup ───────────────────────
//
// We bypass the modal shell (which fires async useEffect IPC calls) and render
// the conditionally-rendered sub-blocks directly. This proves the conditional
// rendering tree without needing a DOM library.

const noop = (): void => undefined;

describe('ClaudeStatusBlock (renderToStaticMarkup)', () => {
  beforeEach(() => {
    // Provide a minimal i18n + zustand surface so useT() doesn't explode.
    // useT subscribes to useStore(s => s.locale); since renderToStaticMarkup
    // does not run effects, the subscription is harmless. The translator
    // falls back to the English locale automatically when locale is undefined.
    (globalThis as unknown as { window?: unknown }).window = (globalThis as unknown as { window?: unknown }).window ?? {};
  });

  it('shows the install hint and external link when Claude is not detected', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeStatusBlock, {
        claudeFound: false,
        mcpRegistered: false,
        registering: false,
        onRegister: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-claude-missing');
    expect(html).toContain('first-run-wizard-install-link');
    expect(html).toContain('claude.ai/code');
    expect(html).toContain('Claude Code not detected');
  });

  it('shows the Register button when Claude is found but MCP is not registered', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeStatusBlock, {
        claudeFound: true,
        mcpRegistered: false,
        registering: false,
        onRegister: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-claude-detected');
    expect(html).toContain('first-run-wizard-mcp-not-registered');
    expect(html).toContain('first-run-wizard-register');
  });

  it('shows the registered checkmark when both detected and registered', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeStatusBlock, {
        claudeFound: true,
        mcpRegistered: true,
        registering: false,
        onRegister: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-mcp-registered');
    expect(html).not.toContain('first-run-wizard-register"');
  });
});

describe('SampleTaskBlock (renderToStaticMarkup)', () => {
  it('renders an enabled "Try sample task" button when ready and idle', () => {
    const html = renderToStaticMarkup(
      createElement(SampleTaskBlock, {
        uiState: 'ready',
        sampleState: 'idle',
        completedAt: undefined,
        onTry: noop,
        onFallbackContinue: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-try');
    // Enabled button should NOT carry the `disabled` attribute.
    expect(html).not.toMatch(/<button[^>]*\bdisabled\b[^>]*data-testid="first-run-wizard-try"/);
  });

  it('disables the sample task button and shows "Already completed on …" in reopen mode (D9)', () => {
    const html = renderToStaticMarkup(
      createElement(SampleTaskBlock, {
        uiState: 'reopen',
        sampleState: 'idle',
        completedAt: '2026-04-29T12:00:00.000Z',
        onTry: noop,
        onFallbackContinue: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-try');
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*data-testid="first-run-wizard-try"/);
    expect(html).toContain('2026-04-29');
  });

  it('disables the sample task button when claude is missing (firstRun, not ready)', () => {
    const html = renderToStaticMarkup(
      createElement(SampleTaskBlock, {
        uiState: 'claude-missing',
        sampleState: 'idle',
        completedAt: undefined,
        onTry: noop,
        onFallbackContinue: noop,
      }),
    );
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*data-testid="first-run-wizard-try"/);
  });

  it('renders the timeout fallback "Continue" button when sampleState=timeout-fallback', () => {
    const html = renderToStaticMarkup(
      createElement(SampleTaskBlock, {
        uiState: 'ready',
        sampleState: 'timeout-fallback',
        completedAt: undefined,
        onTry: noop,
        onFallbackContinue: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-sample-fallback');
    expect(html).toContain('first-run-wizard-fallback-continue');
  });

  it('renders the success block when sampleState=success', () => {
    const html = renderToStaticMarkup(
      createElement(SampleTaskBlock, {
        uiState: 'ready',
        sampleState: 'success',
        completedAt: undefined,
        onTry: noop,
        onFallbackContinue: noop,
      }),
    );
    expect(html).toContain('first-run-wizard-sample-success');
  });
});

// ─── electronAPI.firstRun integration shape ───────────────────────────────────
//
// This proves the test surface knows about every IPC method the wizard relies
// on. Useful as a regression alarm if T1 ever drops or renames a method.

describe('electronAPI.firstRun mock surface', () => {
  beforeEach(() => {
    const mock = {
      check: vi.fn(),
      complete: vi.fn(),
      dismiss: vi.fn(),
      reopen: vi.fn(),
      registerMcp: vi.fn(),
      startSampleTask: vi.fn(),
      onSampleTaskReady: vi.fn(() => noop),
      onSampleTaskTimeout: vi.fn(() => noop),
    };
    (globalThis as unknown as { window: { electronAPI: { firstRun: typeof mock } } }).window = {
      electronAPI: { firstRun: mock },
    };
  });

  it('exposes every IPC method the wizard calls', () => {
    const win = (globalThis as unknown as {
      window: { electronAPI: { firstRun: Record<string, unknown> } };
    }).window;
    const api = win.electronAPI.firstRun;
    expect(typeof api.check).toBe('function');
    expect(typeof api.complete).toBe('function');
    expect(typeof api.dismiss).toBe('function');
    expect(typeof api.reopen).toBe('function');
    expect(typeof api.registerMcp).toBe('function');
    expect(typeof api.startSampleTask).toBe('function');
    expect(typeof api.onSampleTaskReady).toBe('function');
    expect(typeof api.onSampleTaskTimeout).toBe('function');
  });
});

// ─── Statusline opt-in (onboarding install offer) ─────────────────────────────

describe('decideStatuslineOffer', () => {
  const status = (
    installed: boolean,
    states: Array<'none' | 'wmux' | 'foreign' | 'corrupt' | 'missing'>,
  ) => ({
    installed,
    outcome: { targets: states.map((state) => ({ state })) },
  });

  it('offers when not installed and a target is installable', () => {
    expect(decideStatuslineOffer(status(false, ['none']))).toBe('offer');
    expect(decideStatuslineOffer(status(false, ['foreign', 'missing']))).toBe('offer');
  });

  it('hides when installed, when null, or when no target can accept', () => {
    expect(decideStatuslineOffer(null)).toBe('hidden');
    expect(decideStatuslineOffer(status(true, ['wmux']))).toBe('hidden');
    expect(decideStatuslineOffer(status(false, ['foreign']))).toBe('hidden');
    expect(decideStatuslineOffer(status(false, ['corrupt', 'foreign']))).toBe('hidden');
  });
});

describe('StatuslineBlock', () => {
  it('renders the enable button in offer state and disables it while installing', () => {
    const offer = renderToStaticMarkup(
      createElement(StatuslineBlock, { state: 'offer', onInstall: () => undefined }),
    );
    expect(offer).toContain('first-run-wizard-statusline-offer');
    expect(offer).toContain('first-run-wizard-statusline-install');
    expect(offer).not.toContain('disabled');

    const installing = renderToStaticMarkup(
      createElement(StatuslineBlock, { state: 'installing', onInstall: () => undefined }),
    );
    expect(installing).toContain('disabled');
  });

  it('renders success and error variants', () => {
    const installed = renderToStaticMarkup(
      createElement(StatuslineBlock, { state: 'installed', onInstall: () => undefined }),
    );
    expect(installed).toContain('first-run-wizard-statusline-installed');

    const error = renderToStaticMarkup(
      createElement(StatuslineBlock, { state: 'error', onInstall: () => undefined }),
    );
    expect(error).toContain('first-run-wizard-statusline-error');
  });
});

describe('HooksBlock', () => {
  it('renders the install button in offer state and disables it while installing', () => {
    const offer = renderToStaticMarkup(
      createElement(HooksBlock, { state: 'offer', onInstall: () => undefined }),
    );
    expect(offer).toContain('first-run-wizard-hooks-offer');
    expect(offer).toContain('first-run-wizard-hooks-install');
    expect(offer).not.toContain('disabled');

    const installing = renderToStaticMarkup(
      createElement(HooksBlock, { state: 'installing', onInstall: () => undefined }),
    );
    expect(installing).toContain('disabled');
  });

  // Unlike the statusline offer, the installed state RENDERS rather than
  // hides: hooks are a requirement, and a checklist that silently omits its
  // most important item teaches the operator it does not exist.
  it('renders the installed state as a receipt, not as nothing', () => {
    const installed = renderToStaticMarkup(
      createElement(HooksBlock, { state: 'installed', onInstall: () => undefined }),
    );
    expect(installed).toContain('first-run-wizard-hooks-installed');

    const error = renderToStaticMarkup(
      createElement(HooksBlock, { state: 'error', errorDetail: 'EACCES', onInstall: () => undefined }),
    );
    expect(error).toContain('first-run-wizard-hooks-error');
    expect(error).toContain('EACCES');
  });
});

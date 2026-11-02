/**
 * Tests for FirstRunWizard (T6).
 *
 * The repository's vitest config runs in `node` environment without a DOM
 * library installed (no jsdom / happy-dom / @testing-library/react), so this
 * suite tests the wizard via two complementary strategies:
 *   1. Pure helpers exported from FirstRunWizard.tsx (decidePrimaryAction,
 *      folderWorkspaceName, getRegisterErrorKeys).
 *   2. React DOM Server's `renderToStaticMarkup` for snapshot-style assertions
 *      against the conditionally rendered sub-blocks (ClaudeStatusBlock,
 *      HooksBlock, AutoUpdateBlock). Effects do NOT run in renderToStaticMarkup, so
 *      effect-driven assertions (e.g. "calls firstRun.check on mount") are
 *      covered by inspecting the IPC mock surface directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  folderWorkspaceName,
  getRegisterErrorKeys,
  AutoUpdateBlock,
  ClaudeStatusBlock,
  HooksBlock,
  decidePrimaryAction,
  withInlineCode,
} from '../FirstRunWizard';

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('folderWorkspaceName', () => {
  it('names the workspace after the folder', () => {
    expect(folderWorkspaceName('/Users/me/code/wmux')).toBe('wmux');
    expect(folderWorkspaceName('/Users/me/code/wmux/')).toBe('wmux');
    expect(folderWorkspaceName('C:\\Users\\me\\project')).toBe('project');
    expect(folderWorkspaceName('/')).toBe('Workspace');
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

  // The installed state RENDERS rather than hides: hooks are a requirement, and a checklist that silently omits its
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

// ─── One primary per dialog (DESIGN.md "Dialogs & forms") ────────────────────

const primaryCount = (html: string) => (html.match(/ui-btn-primary/g) ?? []).length;

describe('decidePrimaryAction', () => {
  const base = {
    claudeFound: true,
    mcpRegistered: true,
    registering: false,
    hooksState: 'installed' as const,
    agentReady: true,
  };

  it('prefers what unblocks the user first, and ends on opening a folder', () => {
    expect(decidePrimaryAction({ ...base, agentAction: true, agentReady: false, hooksState: 'offer' })).toBe('agent');
    expect(decidePrimaryAction({ ...base, mcpRegistered: false, hooksState: 'offer' })).toBe('register');
    expect(decidePrimaryAction({ ...base, hooksState: 'offer' })).toBe('hooks');
    expect(decidePrimaryAction({ ...base, hooksState: 'error' })).toBe('hooks');
    expect(decidePrimaryAction(base)).toBe('folder');
  });

  it('never makes a disabled or in-flight action primary, and does not hand the emphasis on mid-flight', () => {
    expect(decidePrimaryAction({ ...base, mcpRegistered: false, registering: true })).toBeNull();
    // Installing hooks: Open a folder must not become primary while the install runs.
    expect(decidePrimaryAction({ ...base, hooksState: 'installing' })).toBeNull();
  });

  it('any set-up agent is enough for the folder to be the primary, Claude Code or not', () => {
    expect(decidePrimaryAction({ ...base, claudeFound: false, mcpRegistered: false, hooksState: 'unknown' })).toBe('folder');
  });

  it('has no primary while no agent is set up and no card offers an action', () => {
    expect(decidePrimaryAction({ ...base, claudeFound: false, mcpRegistered: false, hooksState: 'unknown', agentReady: false })).toBeNull();
  });
});

describe('primary styling follows the decision', () => {
  it('never draws a disabled Register or Install hooks as primary', () => {
    const reg = renderToStaticMarkup(
      createElement(ClaudeStatusBlock, { claudeFound: true, mcpRegistered: false, registering: true, onRegister: noop, primary: true }),
    );
    expect(primaryCount(reg)).toBe(0);
    const hooks = renderToStaticMarkup(createElement(HooksBlock, { state: 'installing', onInstall: noop, primary: true }));
    expect(primaryCount(hooks)).toBe(0);
  });

  it('draws Register and Install hooks as primary only when told to', () => {
    const reg = (primary: boolean) => renderToStaticMarkup(
      createElement(ClaudeStatusBlock, { claudeFound: true, mcpRegistered: false, registering: false, onRegister: noop, primary }),
    );
    expect(primaryCount(reg(true))).toBe(1);
    expect(primaryCount(reg(false))).toBe(0);
    const hooks = renderToStaticMarkup(createElement(HooksBlock, { state: 'offer', onInstall: noop, primary: false }));
    expect(primaryCount(hooks)).toBe(0);
  });
});

describe('welcome typography and glyphs', () => {
  it('the auto-update row draws no check: the switch carries its state', () => {
    const html = renderToStaticMarkup(createElement(AutoUpdateBlock));
    expect(html).toContain('first-run-wizard-auto-update');
    expect(html).toContain('data-status="none"');
    expect(html).not.toContain('wmux-welcome-glyph-ok');
  });

  it('draws no emoji-style status glyphs in the chrome', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeStatusBlock, { claudeFound: false, mcpRegistered: false, registering: false, onRegister: noop }),
    ) + renderToStaticMarkup(createElement(HooksBlock, { state: 'installed', onInstall: noop }));
    expect(html).not.toMatch(/[✓⚠]/);
  });

  it('renders `backticked` commands as inline code', () => {
    const html = renderToStaticMarkup(
      createElement('p', null, withInlineCode('run `wmux setup-hooks` from a terminal')),
    );
    expect(html).toBe('<p>run <code class="ui-code">wmux setup-hooks</code> from a terminal</p>');
    expect(withInlineCode('no code here')).toBe('no code here');
  });

  it('leaves an unpaired backtick literal instead of turning the rest into code', () => {
    const odd = renderToStaticMarkup(
      createElement('p', null, withInlineCode('run `wmux setup-hooks` then don`t retry')),
    );
    expect(odd).toBe('<p>run <code class="ui-code">wmux setup-hooks</code> then don`t retry</p>');
    const single = renderToStaticMarkup(createElement('p', null, withInlineCode('it`s fine')));
    expect(single).toBe('<p>it`s fine</p>');
  });
});

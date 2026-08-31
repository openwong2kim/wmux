import { describe, it, expect } from 'vitest';
import {
  buildCodexHooksConfig,
  renderCodexHooksToml,
  codexSupportsHooks,
  CODEX_HOOK_EVENTS,
  CODEX_HOOKS_MANAGED_MARKER,
  CODEX_HOOKS_MIN_VERSION,
  CODEX_HOOK_TIMEOUT_MS,
} from '../hooks/wmuxHooks.mjs';

const BRIDGE = 'C:\\Users\\me\\AppData\\Local\\wmux\\wmux-codex-hooks-bridge.mjs';

describe('buildCodexHooksConfig', () => {
  it('registers exactly the events the bridge maps', () => {
    expect(Object.keys(buildCodexHooksConfig(BRIDGE)).sort())
      .toEqual([...CODEX_HOOK_EVENTS].sort());
  });

  it('emits Codex handler shape with both command fields', () => {
    const [group] = buildCodexHooksConfig(BRIDGE).Stop;
    expect(group.matcher).toBe('*');
    expect(group.hooks).toEqual([
      {
        type: 'command',
        command: `node "${BRIDGE}"`,
        commandWindows: `node "${BRIDGE}"`,
        timeout: CODEX_HOOK_TIMEOUT_MS,
        async: false,
      },
    ]);
  });

  // Synchronous on purpose: an async Stop can race the next turn's
  // UserPromptSubmit and flip the pane's state backwards. The bridge's own 2s
  // cap is what keeps sync cheap, and Codex's timeout is the backstop above it.
  it('runs synchronously with a timeout above the bridge self-cap', () => {
    for (const event of CODEX_HOOK_EVENTS) {
      const [handler] = buildCodexHooksConfig(BRIDGE)[event][0].hooks;
      expect(handler.async, event).toBe(false);
      expect(handler.timeout, event).toBeGreaterThan(2000);
    }
  });
});

describe('renderCodexHooksToml', () => {
  it('renders a wmux-owned block for every event', () => {
    const toml = renderCodexHooksToml(BRIDGE);
    expect(toml).toContain(`# ${CODEX_HOOKS_MANAGED_MARKER}`);
    for (const event of CODEX_HOOK_EVENTS) {
      expect(toml, event).toContain(`[[hooks.${event}]]`);
      expect(toml, event).toContain(`[[hooks.${event}.hooks]]`);
    }
  });

  // Windows paths are the whole reason this is JSON.stringify and not a bare
  // template: an unescaped backslash makes the TOML parse as an escape and
  // Codex rejects (or worse, silently mangles) the command.
  it('escapes backslashes in the bridge path', () => {
    expect(renderCodexHooksToml(BRIDGE)).toContain('node \\"C:\\\\Users\\\\me');
  });
});

describe('codexSupportsHooks', () => {
  // The bisected floor. 0.140.0 accepts the same config block, reports
  // `hooks stable true`, offers --dangerously-bypass-hook-trust — and fires
  // nothing. Only the version separates them.
  it('accepts the measured-firing versions', () => {
    for (const v of ['0.141.0', '0.143.0', '0.151.0', 'codex-cli 0.151.0', '1.0.0']) {
      expect(codexSupportsHooks(v), v).toBe(true);
    }
  });

  it('rejects the measured-silent versions', () => {
    for (const v of ['0.135.0', '0.140.0', 'codex-cli 0.140.0', '0.99.0']) {
      expect(codexSupportsHooks(v), v).toBe(false);
    }
  });

  // 0.145.0-alpha.2 was measured firing, and it is above the floor either way.
  it('accepts a pre-release above the floor', () => {
    expect(codexSupportsHooks('codex-cli 0.145.0-alpha.2')).toBe(true);
    expect(codexSupportsHooks('0.140.0-alpha.1')).toBe(false);
  });

  // The case that actually matters: a pre-release AT the floor is a build made
  // BEFORE 0.141.0 shipped, so it sits in the 0.140.0 silent-no-fire zone the
  // floor exists to exclude. Ordering it as ">= 0.141.0" would let the one
  // build class nobody can verify through the gate.
  it('rejects a pre-release of the floor version itself', () => {
    for (const v of ['0.141.0-alpha.0', 'codex-cli 0.141.0-rc.1', '0.141.0-nightly']) {
      expect(codexSupportsHooks(v), v).toBe(false);
    }
    // The released floor itself still passes.
    expect(codexSupportsHooks('0.141.0')).toBe(true);
  });

  // Fail closed. An unknown build that silently runs no hooks is exactly the
  // failure this gate exists to prevent; falling back to the screen detector
  // is the safe side.
  it('treats an unreadable version as too old', () => {
    for (const v of [undefined, null, '', 'unknown', 'codex-cli']) {
      expect(codexSupportsHooks(v as unknown as string), String(v)).toBe(false);
    }
  });

  it('pins the documented floor', () => {
    expect(CODEX_HOOKS_MIN_VERSION).toBe('0.141.0');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level lock for the #1950 dead-input diagnostics. jsdom can't run
 * xterm's custom key handler faithfully (see useTerminal.ctrlLetterEncoding),
 * so like the other handler locks this pins the wiring in the source.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

describe('useTerminal dead-input diagnostics (#1950, source-level lock)', () => {
  it('the attach wrapper returns the handler answer unchanged and records the keydown verdict', () => {
    const start = SRC.indexOf('terminal.attachCustomKeyEventHandler((e) => {');
    expect(start).toBeGreaterThan(-1);
    const wrapper = SRC.slice(start, SRC.indexOf('const handleTerminalKey', start));
    expect(wrapper).toMatch(/const pass = handleTerminalKey\(e\);/);
    expect(wrapper).toMatch(/if \(e\.type === 'keydown'\) \{\s*keyVerdict = \{/);
    expect(wrapper).toMatch(/by: pass \? 'none' : describeDeclinedKey\(e,/);
    expect(wrapper).toMatch(/\}\s*return pass;\s*\}\);/);
  });

  it('the watchdog keydown listener feeds modifiers, stale modifiers, defaultPrevented and the verdict', () => {
    const start = SRC.indexOf('const onWatchdogKeyDown = (e: Event): void => {');
    expect(start).toBeGreaterThan(-1);
    const listener = SRC.slice(start, SRC.indexOf("terminal.textarea?.addEventListener('keydown', onWatchdogKeyDown);", start));
    expect(listener).toMatch(/mods: formatModifiers\(modifiersOf\(ke\)\)/);
    expect(listener).toMatch(/staleMods: modifierPresses\.staleModifiers\(ke\)/);
    expect(listener).toMatch(/defaultPrevented: ke\.defaultPrevented/);
    expect(listener).toMatch(/verdict: keyVerdict\?\.event === ke \? keyVerdict\.by : 'unseen'/);
  });

  it('the log line carries every new field', () => {
    const start = SRC.indexOf('`[wmux:dead-input] pty=');
    const line = SRC.slice(start, SRC.indexOf(');', start));
    for (const field of ['keyKinds=', 'mods=', 'stale=', 'verdict=', 'prevented=', 'xtermComposing=', 'docFocus=']) {
      expect(line).toContain(field);
    }
  });
});

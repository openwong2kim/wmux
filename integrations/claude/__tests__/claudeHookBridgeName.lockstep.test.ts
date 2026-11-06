// The Claude bridge's file name has three readers that must agree: the hook
// installer's ownership marker (setupHooks.ts WMUX_BRIDGE_MARKER), the native
// hook's lookup beside its binary (claude_hook.rs BRIDGE_BASENAME), and the
// native dispatch on the bridge path a settings entry names in argv[1]
// (main.rs, which must use that same constant rather than its own copy).
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...rel), 'utf8').replace(/\r\n/g, '\n');

describe('the Claude bridge file name', () => {
  it('is the same in the installer and the native hook', () => {
    const marker = read('src', 'cli', 'commands', 'setupHooks.ts').match(/^const WMUX_BRIDGE_MARKER = '([^']+)';$/m)?.[1];
    const native = read('core', 'wmux-native', 'src', 'claude_hook.rs').match(/^pub\(crate\) const BRIDGE_BASENAME: &str = "([^"]+)";$/m)?.[1];
    expect(marker).toBe('wmux-bridge.mjs');
    expect(native).toBe(marker);
  });

  it('is what the native dispatch matches, through the hook\'s own constant', () => {
    const main = read('core', 'wmux-native', 'src', 'main.rs');
    expect(main).toContain('claude_hook::BRIDGE_BASENAME');
    expect(main).not.toMatch(/"wmux-bridge\.mjs"/);
  });
});

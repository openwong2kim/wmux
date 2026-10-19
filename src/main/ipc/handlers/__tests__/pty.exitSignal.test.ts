import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readSourceText } from '../../../../test-utils/sourceText';

/**
 * Source-level lock (#1838): node-pty reports a signal-killed shell as exit
 * code 0 with the signal beside it. The renderer closes a tab on a clean exit,
 * so the daemon → main → renderer exit path must carry the signal, or kill -9,
 * a crash or an OOM kill would close the tab and lose its scrollback. Both hops
 * are wired deep inside daemon and electron setup, so like the reconnect locks
 * they are pinned at the source level.
 */
const read = (rel: string) => readSourceText(path.resolve(process.cwd(), rel));

describe('exit signal reaches the renderer (source-level lock)', () => {
  it('the daemon broadcasts the signal with session.died', () => {
    const src = read('src/daemon/index.ts');
    const at = src.indexOf("type: 'session.died'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/signal: payload\.signal/);
  });

  it('main forwards the daemon signal on PTY_EXIT', () => {
    expect(read('src/main/ipc/handlers/pty.handler.ts')).toMatch(
      /send\(IPC\.PTY_EXIT, payload\.sessionId, payload\.exitCode \?\? -1, payload\.signal \?\? null\)/,
    );
  });
});

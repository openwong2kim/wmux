// Regression guard: the fan-out caller IPC handlers check the sender like the
// other main-window handlers. DECK_FANOUT_CALLER_SUBMIT delivers a prompt into
// an agent pane and DECK_FANOUT_CALLER_SESSION reads its session, so a
// <webview> guest or subframe must not reach them — only the main window's
// own top frame (isTrustedMainFrameSender), as every neighbouring handler does.
//
// Source-scan (index.ts pulls in the full Electron main graph, which the
// node-env vitest can't import), mirroring registerHandlers.rpcInvoke.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8');

describe('fan-out caller IPC handlers check the sender', () => {
  for (const channel of ['DECK_FANOUT_CALLER_SESSION', 'DECK_FANOUT_CALLER_SUBMIT']) {
    it(`${channel} is gated with isTrustedMainFrameSender`, () => {
      // The handle call for this channel and an isTrustedMainFrameSender check
      // within the same (short) handler body.
      const re = new RegExp(`handle\\(IPC\\.${channel},[\\s\\S]{0,200}?isTrustedMainFrameSender`);
      expect(SRC).toMatch(re);
    });
  }

  it('neither handler ignores its event argument any more', () => {
    expect(SRC).not.toMatch(/handle\(IPC\.DECK_FANOUT_CALLER_(?:SESSION|SUBMIT), \(_e,/);
  });
});

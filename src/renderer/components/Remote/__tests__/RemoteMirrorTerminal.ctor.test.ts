// @vitest-environment jsdom
//
// The options the mirror actually constructs its terminal with, checked
// against the REAL @xterm/xterm and the REAL width model.
//
// This file exists because the sibling suite mocks both of those, so it
// verified mock-to-mock call ordering and passed 15/15 while the component
// threw on every mount in production: `applyUnicodeWidthModel` installs
// Unicode11Addon, which reads `term.unicode`, which xterm gates behind
// `allowProposedApi` and throws without. A mount effect that throws reaches the
// boundary around the whole main area, so a single attached remote workspace
// took the entire local pane grid down.
//
// Nothing here is mocked. If the ctor options and the addon ever disagree
// again, this fails.

import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { applyUnicodeWidthModel } from '../../../../shared/terminalUnicode';

/** The exact option bag RemoteMirrorTerminal passes, minus the store reads. */
function mirrorCtorOptions() {
  return {
    convertEol: false,
    scrollback: 2000,
    disableStdin: false,
    fontSize: 14,
    fontFamily: 'Cascadia Code, monospace',
    theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    minimumContrastRatio: 2.5,
    allowProposedApi: true,
  };
}

describe('RemoteMirrorTerminal terminal construction', () => {
  it('survives the shared width model — the addon needs proposed API', () => {
    const term = new Terminal(mirrorCtorOptions());
    try {
      expect(() => applyUnicodeWidthModel(term)).not.toThrow();
    } finally {
      term.dispose();
    }
  });

  // The negative control. Without the flag the same call throws, which is what
  // the component shipped as before this test existed — so a regression here
  // cannot pass by accident.
  it('throws without allowProposedApi, proving the flag is load-bearing', () => {
    const { allowProposedApi: _omitted, ...withoutFlag } = mirrorCtorOptions();
    void _omitted;
    const term = new Terminal(withoutFlag);
    try {
      expect(() => applyUnicodeWidthModel(term)).toThrow(/proposed API/i);
    } finally {
      term.dispose();
    }
  });
});

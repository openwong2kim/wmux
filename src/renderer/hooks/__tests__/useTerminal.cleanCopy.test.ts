import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Clean copy wiring, locked at the source level like the other useTerminal
// wiring tests: the hook is an xterm-bound effect that unit tests cannot
// mount. The resolver and the copy helpers are tested for real in
// utils/__tests__/{cleanCopyResolve,copyWithFeedback,autoSelectionCopy}.test.ts.
describe('clean copy — copy entry point wiring (source-level)', () => {
  // LF only: with core.autocrlf (the Windows default) the checkout is CRLF.
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');
  const src = read('useTerminal.ts');
  const mainStart = src.indexOf('if (!container || !ptyId) return;');
  const mainEffect = src.slice(mainStart, src.indexOf('}, [ptyId, containerRef]);', mainStart));
  const helper = src.slice(src.indexOf('export function copySelectionWithFeedback('), src.indexOf('const RIGHT_CLICK_PASTE_SUPPRESS_MS'));

  it('copySelectionWithFeedback resolves through the pane only when given a ptyId, newest copy winning', () => {
    expect(helper).toMatch(/options\?: \{ keepSelection\?: boolean; ptyId\?: string \}/);
    expect(helper).toMatch(/resolve: ptyId \? \(text\) => resolveCopyText\(ptyId, text\) : undefined,/);
    expect(helper).toMatch(/isCurrent: startCopy\(\),/);
  });

  it('passes the pane ptyId at the Cmd+C, Ctrl+C and Ctrl+Shift+C copies', () => {
    const keys = mainEffect.slice(mainEffect.indexOf('terminal.attachCustomKeyEventHandler('));
    const at = (marker: string) => keys.slice(keys.indexOf(marker), keys.indexOf(marker) + 1200);
    for (const marker of [
      "if (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'c' || e.code === 'KeyC'))",
      "if (!isMac && resolveCtrlLetterByte(e) === '\\x03')",
      "if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.code === 'KeyC'))",
    ]) {
      expect(keys.indexOf(marker), marker).toBeGreaterThan(-1);
      expect(at(marker)).toMatch(/void copySelectionWithFeedback\(terminal, sel, \{ ptyId \}\);/);
    }
    expect(mainEffect).not.toMatch(/copySelectionWithFeedback\(terminal, sel\)/);
  });

  it('passes the pane ptyId at the right-click copy', () => {
    expect(mainEffect).toMatch(/autoCopy\.dispose\(\);\s*\n\s*void copySelectionWithFeedback\(terminal, sel, \{ keepSelection: true, ptyId \}\);/);
  });

  it('auto-copy resolves through the pane after its debounce', () => {
    const autoCopy = mainEffect.slice(mainEffect.indexOf('const autoCopy = createAutoSelectionCopy({'), mainEffect.indexOf('const selectionDisposable'));
    expect(autoCopy).toMatch(/resolve: \(text\) => resolveCopyText\(ptyId, text\),/);
  });

  it('the remote mirror copies stay raw: no ptyId, no resolver', () => {
    const mirror = read('../components/Remote/RemoteMirrorTerminal.tsx');
    expect(mirror).toMatch(/copySelectionWithFeedback\(term, term\.getSelection\(\)\)/);
    expect(mirror).not.toMatch(/resolveCopyText|ptyId \}\)/);
    const autoCopy = mirror.slice(mirror.indexOf('createAutoSelectionCopy({'), mirror.indexOf('});', mirror.indexOf('createAutoSelectionCopy({')));
    expect(autoCopy).not.toMatch(/resolve:/);
  });

  it('passes the pane ptyId at the context-menu Copy and the document-level copy shortcut', () => {
    expect(read('../components/Terminal/Terminal.tsx')).toMatch(/void copySelectionWithFeedback\(terminalRef\.current, ctxMenu\.selectedText, \{ ptyId: ptyId \?\? undefined \}\);/);
    expect(read('useTerminalCopyShortcut.ts')).toMatch(/target\.selection,\s*\n\s*\{ ptyId: target\.ptyId \},/);
  });
});

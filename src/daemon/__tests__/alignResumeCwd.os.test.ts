import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { alignResumeCwd } from '../alignResumeCwd';
import { toResumeCommand } from '../../shared/agentResume';
import { blockAt, readSourceText } from '../../test-utils/sourceText';

describe('alignResumeCwd', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // A junction needs no symlink privilege on Windows; elsewhere the type is ignored.
  function symlinkedFolder(): { real: string; link: string; root: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-align-'));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { real, link, root };
  }

  it('gives a binding the pane spelling when both name one folder through a symlink', () => {
    const { real, link, root: dir } = symlinkedFolder();
    const b = { agent: 'claude', sessionId: 'x', cwd: real };
    expect(alignResumeCwd(b, { cwd: link }).cwd).toBe(link);
    expect(alignResumeCwd(b, { cwd: dir }).cwd).toBe(real); // a different folder stays a mismatch
    expect(alignResumeCwd(b, { cwd: path.join(dir, 'gone') })).toBe(b); // unresolvable: unchanged
  });

  it('lets an exec replay in a symlinked folder resume the exact conversation', () => {
    const { real, link } = symlinkedFolder();
    const binding = { agent: 'claude' as const, sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', cwd: real, ts: 1 };
    expect(toResumeCommand('claude', binding, link)).not.toContain(binding.sessionId);
    expect(toResumeCommand('claude', alignResumeCwd(binding, { cwd: link }), link)).toContain(`--resume ${binding.sessionId}`);
  });

  it('leaves a folder-less or already-matching binding alone', () => {
    const b = { cwd: undefined };
    expect(alignResumeCwd(b, { cwd: '/x' })).toBe(b);
    const same = { cwd: '/x/' };
    expect(alignResumeCwd(same, { cwd: '/x' }, () => { throw new Error('not called'); })).toBe(same);
  });

  it('does not resolve a WSL pane folder on the host', () => {
    const b = { cwd: '/home/u/app' };
    const never = () => { throw new Error('not called'); };
    expect(alignResumeCwd(b, { cwd: '/home/u/link', wslTarget: { distribution: 'Ubuntu', user: 'u' } }, never)).toBe(b);
    if (process.platform === 'win32') {
      expect(alignResumeCwd(b, { cwd: '/home/u/link', cmd: 'wsl.exe' }, never)).toBe(b);
    }
  });

  // The replay and live-capture paths live inside index.ts's closures: pin
  // that each aligns the binding before its cwd-sensitive step.
  describe('daemon wiring', () => {
    const src = readSourceText(path.join(__dirname, '..', 'index.ts'));

    it('resumeLaunchCommand aligns the binding before toResumeCommand', () => {
      const body = blockAt(src, src.indexOf('function resumeLaunchCommand('));
      const align = body.indexOf('alignResumeCwd(binding, session)');
      expect(align).toBeGreaterThan(-1);
      expect(align).toBeLessThan(body.indexOf('toResumeCommand('));
    });

    it('a live capture is aligned before mergeResumeBinding', () => {
      const merge = src.indexOf('const next = mergeResumeBinding(managed.meta.resumeBinding, p.resumeBinding);');
      expect(merge).toBeGreaterThan(-1);
      const align = src.indexOf('p.resumeBinding = alignResumeCwd(p.resumeBinding, managed.meta);');
      expect(align).toBeGreaterThan(-1);
      expect(merge - align).toBeGreaterThan(0);
      expect(merge - align).toBeLessThan(400); // only the merge's own comment between them
    });
  });
});

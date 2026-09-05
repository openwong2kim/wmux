/**
 * The type-scale guard: .eslintrc.json forbids the off-scale text sizes that
 * had drifted into src/renderer (8, 9, 10.5, 11.5, 12.5 px) so the DESIGN.md
 * ramp — 10px section labels / 11px meta+tool lines / 13px body / 14px titles
 * — cannot silently regrow a fifth and sixth step.
 *
 * The test drives the real repo config (no inline rule copy) so it fails if the
 * override is deleted, renamed, or scoped away from src/renderer.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
// A path that does not exist on disk is fine for lintText; ESLint only uses it
// to resolve which config overrides apply.
const RENDERER_FILE = path.join(REPO_ROOT, 'src/renderer/components/__fixture__.tsx');
const TEST_FILE = path.join(REPO_ROOT, 'src/renderer/components/__tests__/__fixture__.tsx');
const TERMINAL_FILE = path.join(REPO_ROOT, 'src/renderer/components/Terminal/__fixture__.tsx');

const eslint = new ESLint({ cwd: REPO_ROOT });

async function scaleErrors(code: string, filePath = RENDERER_FILE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
}

describe('off-scale text size lint rule', () => {
  it('fires on a string className', async () => {
    const errors = await scaleErrors('export const a = <span className="text-[9px] font-mono" />;\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Off-scale text size');
  });

  it('fires on a template-literal className', async () => {
    const errors = await scaleErrors(
      'declare const ring: string;\nexport const a = <span className={`px-1 text-[10.5px] ${ring}`} />;\n',
    );
    expect(errors).toHaveLength(1);
  });

  it('fires on a class-name constant declared outside JSX', async () => {
    const errors = await scaleErrors("export const labelCls = 'text-[12.5px] font-semibold';\n");
    expect(errors).toHaveLength(1);
  });

  it('fires on a numeric inline fontSize', async () => {
    const errors = await scaleErrors('export const a = <span style={{ fontSize: 8 }} />;\n');
    expect(errors).toHaveLength(1);
  });

  it('fires on a string inline fontSize', async () => {
    const errors = await scaleErrors("export const a = <span style={{ fontSize: '11.5px' }} />;\n");
    expect(errors).toHaveLength(1);
  });

  it('covers every banned step', async () => {
    for (const step of ['8', '9', '10.5', '11.5', '12.5']) {
      const errors = await scaleErrors(`export const a = <span className="text-[${step}px]" />;\n`);
      expect(errors, `text-[${step}px] should be rejected`).toHaveLength(1);
    }
  });

  it('allows the DESIGN.md scale steps', async () => {
    for (const step of ['10', '11', '13', '14']) {
      const errors = await scaleErrors(`export const a = <span className="text-[${step}px]" />;\n`);
      expect(errors, `text-[${step}px] should be allowed`).toEqual([]);
    }
    expect(await scaleErrors('export const a = <span style={{ fontSize: 13 }} />;\n')).toEqual([]);
  });

  it('does not fire inside renderer test files, which assert on class strings', async () => {
    const errors = await scaleErrors("export const a = 'text-[9px]';\n", TEST_FILE);
    expect(errors).toEqual([]);
  });

  it('exempts the Terminal tree, which owns its own scale', async () => {
    const errors = await scaleErrors('export const a = <span className="text-[9px]" />;\n', TERMINAL_FILE);
    expect(errors).toEqual([]);
  });

  it('says where the terminal exemption actually lives', async () => {
    // The first message wording claimed terminal sizes live "outside
    // src/renderer", which is false — src/renderer/components/Terminal is the
    // exemption, and it is expressed in excludedFiles, not in prose.
    const [msg] = await scaleErrors('export const a = <span className="text-[9px]" />;\n');
    expect(msg).toContain('src/renderer/components/Terminal/**');
    expect(msg).not.toContain('outside src/renderer');
  });

  it('stays live inside the files that carry per-line suppressions', async () => {
    // The two files a sibling PR owns are suppressed line-by-line, not by a
    // file-level carve-out, so every OTHER off-scale size in them still fails.
    for (const rel of [
      'src/renderer/components/Sidebar/MissionsSection.tsx',
      'src/renderer/components/Deck/DeckLedgerPanel.tsx',
    ]) {
      const errors = await scaleErrors(
        'export const a = <span className="text-[8px]" />;\n',
        path.join(REPO_ROOT, rel),
      );
      expect(errors, `${rel} still linted`).toHaveLength(1);
    }
  });
});

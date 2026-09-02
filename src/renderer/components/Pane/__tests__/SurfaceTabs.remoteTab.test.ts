// @vitest-environment jsdom
//
// jsdom because the tooltip runs the path through `displayPath`, which reads
// `window.electronAPI?.platform` (macOS gets NFC normalization) off a bare
// `window`.
/**
 * A remote tab has to look remote (#1140 dogfood).
 *
 * The finding: a remote-terminal tab was indistinguishable from a local one.
 * Both carry the same status dot and the same close button, and the TITLE is
 * no help at all — it is an OSC title the shell on the other machine sets, so
 * a Windows host renders `C:\Program Files\…\pwsh` exactly as a local pane
 * does. The cwd in the tooltip is worse than useless: it is a real path on a
 * machine that is not this one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { surfaceTabTooltip } from '../SurfaceTabs';

const t = ((key: string) => (key === 'surface.remoteTerminal' ? 'Remote terminal' : 'Terminal')) as
  Parameters<typeof surfaceTabTooltip>[1];

describe('surfaceTabTooltip', () => {
  it('a local tab leads with its working directory, unchanged', () => {
    expect(surfaceTabTooltip({ cwd: 'D:\\wmux', title: 'pwsh' }, t)).toBe('D:\\wmux');
  });

  it('a local tab with no cwd yet falls back to the title, then the noun', () => {
    expect(surfaceTabTooltip({ title: 'pwsh' }, t)).toBe('pwsh');
    expect(surfaceTabTooltip({}, t)).toBe('Terminal');
  });

  it('a remote tab says so BEFORE the path, which belongs to another machine', () => {
    expect(
      surfaceTabTooltip(
        { surfaceType: 'remote-terminal', cwd: 'C:\\Users\\someone', title: 'pwsh' },
        t,
      ),
    ).toBe('Remote terminal — C:\\Users\\someone');
  });

  it('a remote tab still identifies itself when it has neither cwd nor title', () => {
    expect(surfaceTabTooltip({ surfaceType: 'remote-terminal' }, t))
      .toBe('Remote terminal — Terminal');
  });
});

describe('the remote glyph', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/Pane/SurfaceTabs.tsx'),
    'utf8',
  );

  it('marks remote tabs, and reuses the icon the remote menu entries already use', () => {
    expect(source).toContain("s.surfaceType === 'remote-terminal'");
    // The ⋮ menu's "New remote pane" / "Split … — remote" entries carry
    // IconExternalLink; the tab they produce carrying anything else would make
    // the action and its result read as two unrelated things.
    expect(source).toMatch(/remote-terminal'[\s\S]{0,400}IconExternalLink/);
  });

  it('the glyph is labelled, since it is the only thing that says "remote"', () => {
    expect(source).toMatch(/aria-label=\{t\('surface\.remoteTerminal'\)\}/);
  });
});

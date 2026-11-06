// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDomSnapshotExpression, FRAME_BOUNDARY_SUFFIX, FRAME_LINE_CAP } from '../dom-intelligence';

// Frame boundary lines in the DOM listing: one line per frame element, read
// from the element itself, so it costs no extra round trip and covers frames
// in other processes too.

function run(expr: string): string {
  return (0, eval)(expr) as string;
}

function frameLines(out: string): string[] {
  const at = out.indexOf('Frames (separate documents):');
  if (at < 0) return [];
  return out.slice(at).split('\n').slice(1).filter((l) => l.startsWith('  '));
}

describe('frame boundary lines', () => {
  it('lists each frame after the interactive elements: role, name, location, boundary', () => {
    document.body.innerHTML =
      '<button>Pay</button><iframe title="Card form" src="https://pay.example/checkout"></iframe>';
    const out = run(buildDomSnapshotExpression());
    expect(frameLines(out)).toEqual([`  iframe "Card form" -> https://pay.example/checkout ${FRAME_BOUNDARY_SUFFIX}`]);
    expect(out.indexOf('[ref=0] button "Pay"')).toBeLessThan(out.indexOf('Frames (separate documents):'));
    // A boundary line mints no ref.
    expect(document.querySelector('iframe')?.hasAttribute('data-wmux-ref')).toBe(false);
  });

  it('drops credentials, query and fragment from the location', () => {
    document.body.innerHTML =
      '<iframe src="https://user:pa55@ads.example/p/slot?token=s3cret&id=1#frag?x=2"></iframe>' +
      '<iframe src="/embed/video?session=abc"></iframe>';
    const out = run(buildDomSnapshotExpression());
    const [absolute, relative] = frameLines(out);
    expect(absolute).toBe(`  iframe -> https://ads.example/p/slot ${FRAME_BOUNDARY_SUFFIX}`);
    expect(relative).toBe(`  iframe -> ${new URL('/embed/video', document.baseURI).href} ${FRAME_BOUNDARY_SUFFIX}`);
    for (const secret of ['user', 'pa55', 's3cret', 'token', 'frag', 'session', 'abc']) {
      expect(frameLines(out).join('\n')).not.toContain(secret);
    }
  });

  it('names srcdoc, empty and non-web frames by kind only', () => {
    document.body.innerHTML =
      '<iframe srcdoc="<p>inline secret</p>" src="https://ignored.example/"></iframe>' +
      '<iframe></iframe>' +
      '<iframe src="about:blank"></iframe>' +
      '<iframe src="data:text/html,<p>inline secret</p>"></iframe>' +
      '<iframe src="javascript:void(0)"></iframe>';
    const locations = frameLines(run(buildDomSnapshotExpression())).map((l) => l.split(' -> ')[1].replace(` ${FRAME_BOUNDARY_SUFFIX}`, ''));
    expect(locations).toEqual(['about:srcdoc', 'about:blank', 'about:blank', 'data:', 'javascript:']);
  });

  it('takes the name from aria-label, then title, then name, and omits it when there is none', () => {
    document.body.innerHTML =
      '<iframe aria-label="Chat" title="ignored" src="https://a.example/"></iframe>' +
      '<iframe title="  Map\n  of   Seoul " src="https://b.example/"></iframe>' +
      '<iframe name="preview" src="https://c.example/"></iframe>' +
      '<iframe role="presentation" src="https://d.example/"></iframe>';
    expect(frameLines(run(buildDomSnapshotExpression()))).toEqual([
      `  iframe "Chat" -> https://a.example/ ${FRAME_BOUNDARY_SUFFIX}`,
      `  iframe "Map of Seoul" -> https://b.example/ ${FRAME_BOUNDARY_SUFFIX}`,
      `  iframe "preview" -> https://c.example/ ${FRAME_BOUNDARY_SUFFIX}`,
      `  presentation -> https://d.example/ ${FRAME_BOUNDARY_SUFFIX}`,
    ]);
  });

  it('lists at most FRAME_LINE_CAP frames and counts the rest, keeping the listing small', () => {
    const many = 120;
    document.body.innerHTML =
      '<button>Top</button>' +
      Array.from({ length: many }, (_, i) => `<iframe title="${'t'.repeat(200)}" src="https://f${i}.example/${'p'.repeat(300)}?q=${i}"></iframe>`).join('');
    const out = run(buildDomSnapshotExpression());
    const lines = frameLines(out);
    expect(lines).toHaveLength(FRAME_LINE_CAP + 1);
    expect(lines.at(-1)).toBe(`  (+${many - FRAME_LINE_CAP} more frames not listed)`);
    // Name and location are cut, so the whole frame block stays a small share
    // of the 50 000-character snapshot window, and the top document comes first.
    const block = out.slice(out.indexOf('Frames (separate documents):'));
    expect(block.length).toBeLessThan(15_000);
    expect(out.indexOf('"Top"')).toBeLessThan(out.indexOf('Frames (separate documents):'));
  });

  it('is kept under filter:"interactive" and follows the selector scope', () => {
    document.body.innerHTML =
      '<main><iframe title="In" src="https://in.example/"></iframe></main>' +
      '<iframe title="Out" src="https://out.example/"></iframe>';
    expect(frameLines(run(buildDomSnapshotExpression(undefined, { filter: 'interactive' })))).toHaveLength(2);
    const scoped = frameLines(run(buildDomSnapshotExpression('main')));
    expect(scoped).toEqual([`  iframe "In" -> https://in.example/ ${FRAME_BOUNDARY_SUFFIX}`]);
  });

  it('adds nothing to a page without frames', () => {
    document.body.innerHTML = '<button>Only</button>';
    expect(run(buildDomSnapshotExpression())).not.toContain('Frames');
  });
});

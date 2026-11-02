import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { extractCodeBlocks } from '../../../daemon/transcript/parseEntry';
import type { TranscriptPage } from '../../../shared/transcript/turnEvents';
import { forgetNoTranscript, resolveCopyText, type CleanCopyDeps } from '../cleanCopyResolve';

// The whole path a copy takes, nothing mocked: the daemon lifts the code
// blocks out of the agent's markdown (parseEntry.extractCodeBlocks), the
// resolver reads them back as the renderer does, and the matcher compares
// them with a real Claude Code 2.1.316 screen of the same reply (banner rows
// dropped): numbered steps whose code fences are indented inside the items.
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agentReplyCopy', 'listfence.100.json'), 'utf8')) as { rows: string[]; markdown: string };

function deps(): CleanCopyDeps {
  const { text, refs, bodies } = extractCodeBlocks(fx.markdown, 0);
  const page: TranscriptPage = {
    events: [{ id: 'e1', kind: 'assistant_text', text, codeBlocks: refs }],
    cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 },
    hasMore: false,
    truncatedHead: false,
  };
  return {
    snapshot: async () => page,
    codeBlock: async ({ n }) => (bodies.has(n) ? { body: bodies.get(n) as string } : null),
  };
}

/** xterm's selection of whole screen rows `from`..`to`, each right-trimmed. */
function rows(from: string, to: string): string {
  const a = fx.rows.findIndex((r) => r.includes(from));
  const b = fx.rows.findIndex((r, i) => i >= a && r.includes(to));
  return fx.rows.slice(a, b + 1).map((r) => r.trimEnd()).join('\n');
}

beforeEach(() => forgetNoTranscript());

describe('clean copy, daemon to matcher', () => {
  it('a code block inside a list item copies as the TUI shows it', async () => {
    expect(await resolveCopyText('p1', rows('python -c', 'print(1)'), deps())).toBe('python -c "\nprint(1)');
    expect(await resolveCopyText('p1', rows('def f():', 'return a'), deps())).toBe('def f():\n    a = 1\n    if a:\n        return a');
  });

  it('a selection begun from the margin of an indented code line keeps the relative indentation', async () => {
    expect(await resolveCopyText('p1', rows('a = 1', 'return a'), deps())).toBe('    a = 1\n    if a:\n        return a');
  });
});

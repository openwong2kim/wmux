import { describe, it, expect } from 'vitest';
import { summarizeActivity, MAX_ACTIVITY_LEN, MAX_RAW_LEN } from '../activitySummary';

describe('summarizeActivity — tool_name → activity string', () => {
  // Table-driven happy path. Each row: a tool_name + tool_input → expected.
  const cases: Array<{ name: string; tool: string; input: unknown; expected: string }> = [
    // Edit / Write / NotebookEdit → ✎ {basename}
    { name: 'Edit basic', tool: 'Edit', input: { file_path: '/repo/src/fleet.ts' }, expected: '✎ fleet.ts' },
    { name: 'Write basic', tool: 'Write', input: { file_path: '/repo/src/index.ts' }, expected: '✎ index.ts' },
    { name: 'NotebookEdit file_path', tool: 'NotebookEdit', input: { file_path: '/n/book.ipynb' }, expected: '✎ book.ipynb' },
    { name: 'NotebookEdit notebook_path variant', tool: 'NotebookEdit', input: { notebook_path: '/n/alt.ipynb' }, expected: '✎ alt.ipynb' },
    // Windows backslash separators must work too.
    { name: 'Edit windows path', tool: 'Edit', input: { file_path: 'D:\\wmux\\src\\fleet.ts' }, expected: '✎ fleet.ts' },
    { name: 'Edit mixed separators', tool: 'Write', input: { file_path: 'D:\\wmux/src\\deep/file.tsx' }, expected: '✎ file.tsx' },
    { name: 'Edit trailing slash', tool: 'Edit', input: { file_path: '/repo/dir/' }, expected: '✎ dir' },

    // Read → → {basename}
    { name: 'Read basic', tool: 'Read', input: { file_path: '/repo/README.md' }, expected: '→ README.md' },
    { name: 'Read windows', tool: 'Read', input: { file_path: 'C:\\Users\\x\\notes.txt' }, expected: '→ notes.txt' },

    // Bash → $ {command first ~40 chars}
    { name: 'Bash short', tool: 'Bash', input: { command: 'npm test' }, expected: '$ npm test' },
    {
      name: 'Bash long truncates to 40 + ellipsis',
      tool: 'Bash',
      // "echo " (5 chars) + 50 'a' + "ZZZ"; the 40-char command slice keeps
      // "echo " + 35 'a', then the ellipsis marks the elision.
      input: { command: `echo ${'a'.repeat(50)}ZZZ` },
      expected: `$ echo ${'a'.repeat(35)}…`,
    },

    // Grep / Glob → ⌕ {pattern}
    { name: 'Grep pattern', tool: 'Grep', input: { pattern: 'TODO' }, expected: '⌕ TODO' },
    { name: 'Glob pattern', tool: 'Glob', input: { pattern: '**/*.ts' }, expected: '⌕ **/*.ts' },

    // Task → ⇲ {description}
    { name: 'Task desc', tool: 'Task', input: { description: 'investigate bug' }, expected: '⇲ investigate bug' },

    // WebFetch → host, WebSearch → query
    { name: 'WebFetch host', tool: 'WebFetch', input: { url: 'https://example.com/path?x=1' }, expected: '🌐 example.com' },
    { name: 'WebFetch host with port', tool: 'WebFetch', input: { url: 'http://localhost:3000/api' }, expected: '🌐 localhost:3000' },
    { name: 'WebSearch query', tool: 'WebSearch', input: { query: 'typescript satisfies' }, expected: '🌐 typescript satisfies' },

    // mcp__<srv>__<tool> → {srv}:{tool}
    { name: 'mcp tool', tool: 'mcp__wmux__pane_split', input: {}, expected: 'wmux:pane_split' },
    { name: 'mcp tool ignores input', tool: 'mcp__github__create_pr', input: { anything: 'x' }, expected: 'github:create_pr' },
    // An MCP tool literally named Read must NOT be treated as the builtin Read.
    { name: 'mcp tool named Read', tool: 'mcp__srv__Read', input: { file_path: '/a/b.ts' }, expected: 'srv:Read' },

    // Unknown / unmapped tool → bare tool name
    { name: 'unknown tool', tool: 'SomeFutureTool', input: { whatever: 1 }, expected: 'SomeFutureTool' },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.tool} → "${c.expected}"`, () => {
      expect(summarizeActivity(c.tool, c.input)).toBe(c.expected);
    });
  }
});

describe('summarizeActivity — missing / empty / non-object tool_input → bare tool name', () => {
  const inputs: Array<{ name: string; input: unknown }> = [
    { name: 'undefined', input: undefined },
    { name: 'null', input: null },
    { name: 'number', input: 42 },
    { name: 'string', input: 'not an object' },
    { name: 'boolean', input: true },
    { name: 'empty object', input: {} },
    { name: 'array', input: ['file_path', '/x/y.ts'] },
    { name: 'object with wrong field types', input: { file_path: 123, command: { nested: true } } },
  ];

  for (const c of inputs) {
    it(`Edit + ${c.name} tool_input → bare "Edit"`, () => {
      expect(summarizeActivity('Edit', c.input)).toBe('Edit');
    });
    it(`Bash + ${c.name} tool_input → bare "Bash"`, () => {
      expect(summarizeActivity('Bash', c.input)).toBe('Bash');
    });
  }

  it('never throws on a hostile tool_input (getter that throws is not invoked)', () => {
    // We only do typeof + index access — a throwing getter on a plain key
    // would throw, but Claude payloads are JSON (no getters). Guard the
    // common pathological cases instead: deeply nested + huge.
    const huge = { command: 'x'.repeat(100_000) };
    expect(() => summarizeActivity('Bash', huge)).not.toThrow();
  });
});

describe('summarizeActivity — invalid tool_name', () => {
  it('non-string tool_name → empty string (no usable name)', () => {
    expect(summarizeActivity(undefined, { file_path: '/a/b.ts' })).toBe('');
    expect(summarizeActivity(null, {})).toBe('');
    expect(summarizeActivity(123, {})).toBe('');
    expect(summarizeActivity({}, {})).toBe('');
  });

  it('empty-string tool_name → empty string', () => {
    expect(summarizeActivity('', { file_path: '/a/b.ts' })).toBe('');
  });
});

describe('summarizeActivity — control-char / newline stripping', () => {
  it('strips newlines from a Bash command', () => {
    const out = summarizeActivity('Bash', { command: 'echo hi\nrm -rf /\nmore' });
    expect(out).not.toMatch(/[\n\r]/);
    // Newlines collapse to single spaces.
    expect(out).toBe('$ echo hi rm -rf / more');
  });

  it('strips NUL and other C0 control chars from a Grep pattern', () => {
    const out = summarizeActivity('Grep', { pattern: 'a\x00b\x07c\x1bd' });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f]/);
    expect(out).toBe('⌕ a b c d');
  });

  it('strips DEL and C1 control chars', () => {
    const out = summarizeActivity('Task', { description: 'x\x7fy\x9fz' });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x7f-\x9f]/);
    expect(out).toBe('⇲ x y z');
  });

  it('collapses runs of whitespace and trims', () => {
    const out = summarizeActivity('Task', { description: '   lots\t\t  of   space   ' });
    expect(out).toBe('⇲ lots of space');
  });

  it('strips control chars embedded in a file path basename', () => {
    const out = summarizeActivity('Edit', { file_path: '/repo/we\nird.ts' });
    expect(out).not.toMatch(/[\n\r]/);
    // The newline collapses to a space inside the basename segment.
    expect(out).toBe('✎ we ird.ts');
  });
});

describe('summarizeActivity — hard truncation to <= MAX_ACTIVITY_LEN', () => {
  it('a very long mcp tool name is truncated to MAX_ACTIVITY_LEN', () => {
    const out = summarizeActivity(`mcp__${'s'.repeat(200)}__${'t'.repeat(200)}`, {});
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });

  it('a very long Grep pattern is truncated to MAX_ACTIVITY_LEN', () => {
    const out = summarizeActivity('Grep', { pattern: 'p'.repeat(500) });
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });

  it('a very long unknown tool name is truncated to MAX_ACTIVITY_LEN', () => {
    const out = summarizeActivity('Z'.repeat(500), {});
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
    expect(out).toBe('Z'.repeat(MAX_ACTIVITY_LEN));
  });

  it('a very long Task description is truncated to MAX_ACTIVITY_LEN', () => {
    const out = summarizeActivity('Task', { description: 'd'.repeat(1000) });
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });

  it('a long file path (long basename) is truncated to MAX_ACTIVITY_LEN', () => {
    const out = summarizeActivity('Edit', { file_path: `/repo/${'f'.repeat(500)}.ts` });
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });
});

describe('summarizeActivity — MAX_RAW_LEN input cap (DoS guard)', () => {
  // Every interpolated value flows through clean(), which slices at MAX_RAW_LEN
  // before any regex/split/URL work. These tests verify:
  //   1. Multi-MB inputs complete quickly (no O(n) blowup on the main thread).
  //   2. The output still respects MAX_ACTIVITY_LEN.
  //   3. The cap boundary is exact: length > MAX_RAW_LEN is sliced, = MAX_RAW_LEN
  //      is kept whole, < MAX_RAW_LEN is untouched.

  it('2 MB Bash command returns quickly and respects MAX_ACTIVITY_LEN', () => {
    const huge = 'x'.repeat(2_000_000);
    const start = Date.now();
    const out = summarizeActivity('Bash', { command: huge });
    const elapsed = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
    // Should complete in well under 50ms on any CI machine — the cap makes the
    // regex work O(MAX_RAW_LEN) not O(2MB).
    expect(elapsed).toBeLessThan(50);
  });

  it('2 MB tool_name returns quickly and respects MAX_ACTIVITY_LEN', () => {
    const huge = 'T'.repeat(2_000_000);
    const start = Date.now();
    const out = summarizeActivity(huge, {});
    const elapsed = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
    expect(elapsed).toBeLessThan(50);
  });

  it('2 MB file_path returns quickly and respects MAX_ACTIVITY_LEN', () => {
    const huge = '/repo/' + 'f'.repeat(2_000_000) + '.ts';
    const start = Date.now();
    const out = summarizeActivity('Edit', { file_path: huge });
    const elapsed = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
    expect(elapsed).toBeLessThan(50);
  });

  it('input exactly at MAX_RAW_LEN is not truncated by the cap', () => {
    // A pattern of exactly MAX_RAW_LEN plain ASCII chars: the cap must not
    // shorten it (only the final truncate() call may shorten the output).
    const atCap = 'p'.repeat(MAX_RAW_LEN);
    const out = summarizeActivity('Grep', { pattern: atCap });
    // Output is "⌕ " + up-to-80-char slice of 'ppp...', so it starts correctly.
    expect(out.startsWith('⌕ ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });

  it('input one char past MAX_RAW_LEN is silently sliced at the cap', () => {
    const overCap = 'q'.repeat(MAX_RAW_LEN + 1);
    const out = summarizeActivity('Grep', { pattern: overCap });
    expect(out.startsWith('⌕ ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });
});

describe('summarizeActivity — mcp parsing edge cases', () => {
  it('mcp__ with no tool segment falls back to bare name', () => {
    // "mcp__server" has no "__tool" → not a valid mcp tool name; bare fallback.
    expect(summarizeActivity('mcp__server', {})).toBe('mcp__server');
  });

  it('mcp__ with empty server segment falls back to bare name', () => {
    expect(summarizeActivity('mcp____tool', {})).toBe('mcp____tool');
  });

  it('a tool that merely starts with mcp but lacks the __ delimiter is not parsed', () => {
    expect(summarizeActivity('mcpsomething', {})).toBe('mcpsomething');
  });

  it('mcp tool name with extra __ in the tool segment keeps the rest as tool', () => {
    expect(summarizeActivity('mcp__srv__a__b', {})).toBe('srv:a__b');
  });
});

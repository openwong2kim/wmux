// The handoff note from a pane's parsed transcript: the same facts out of a
// Claude Code transcript and a Codex rollout, and the note they make.
import { describe, expect, it } from 'vitest';
import { parseTranscriptLineDetailed } from '../../../daemon/transcript/parseEntry';
import { parseCodexLineDetailed } from '../../../daemon/transcript/parseCodexEntry';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';
import { NOTE_COMMITS_MAX, NOTE_FILES_MAX, NOTE_REPLY_MAX, NOTE_REQUEST_MAX, bringBackNoteText, handoffNoteText, transcriptCommits, transcriptHandoff } from '../handoffNote';

const at = '2026-11-01T10:00:00.000Z';
const parse = (lines: object[], parser: typeof parseTranscriptLineDetailed): TurnEvent[] =>
  lines.flatMap((line, i) => parser(JSON.stringify(line), i * 1000).events);

/** Claude Code: a request, an Edit, a Read of another file, a Write of a plan, the reply. */
const CLAUDE = [
  { type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: 'keep open tasks past the GC' } },
  { type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/work/app/src/board.ts', old_string: 'a', new_string: 'b' } },
  ] } },
  { type: 'user', uuid: 'r1', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: at, message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/work/app/src/other.ts' } },
    { type: 'tool_use', id: 'toolu_3', name: 'Write', input: { file_path: '/work/app/plans/board.md', content: '- blockedBy' } },
  ] } },
  { type: 'user', uuid: 'u2', timestamp: at, message: { role: 'user', content: 'then wire blockedBy' } },
  { type: 'assistant', uuid: 'a3', timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The board keeps open tasks. Next is blockedBy.' }] } },
];

/** Codex CLI: the same session as its rollout records it (apply_patch, a shell read). */
const CODEX = [
  { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'keep open tasks past the GC' } },
  { timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch',
    input: '*** Begin Patch\n*** Update File: /work/app/src/board.ts\n@@\n-a\n+b\n*** End Patch' } },
  { timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: 'call_2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat /work/app/src/other.ts' }) } },
  { timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_3', name: 'apply_patch',
    input: '*** Begin Patch\n*** Add File: /work/app/plans/board.md\n+- blockedBy\n*** End Patch' } },
  { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'then wire blockedBy' } },
  { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: 'The board keeps open tasks. Next is blockedBy.' } },
];

describe('transcriptHandoff', () => {
  it('reads the same requests, reply and written files from Claude Code and Codex transcripts', () => {
    const expected = {
      requests: ['keep open tasks past the GC', 'then wire blockedBy'],
      reply: 'The board keeps open tasks. Next is blockedBy.',
      // The latest written first.
      filesTouched: ['plans/board.md', 'src/board.ts'],
      planFiles: ['plans/board.md'],
    };
    expect(transcriptHandoff(parse(CLAUDE, parseTranscriptLineDetailed), '/work/app')).toEqual(expected);
    expect(transcriptHandoff(parse(CODEX, parseCodexLineDetailed), '/work/app/')).toEqual(expected);
    // Outside the folder, a path stays absolute.
    expect(transcriptHandoff(parse(CLAUDE, parseTranscriptLineDetailed), '/elsewhere').filesTouched).toEqual(['/work/app/plans/board.md', '/work/app/src/board.ts']);
  });

  it('reads the files Codex CLI 0.163 patches from its exec script, where the patch is a string literal', () => {
    // As the rollout records it: `exec` runs a script that calls tools.apply_patch.
    const script = (body: string) => ({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_9', name: 'exec', input: body } });
    const events = parse([
      script('const patch = "*** Begin Patch\\n*** Add File: /work/app/b.md\\n+from codex\\n*** Update File: C:\\\\work\\\\app\\\\src\\\\new.ts\\n@@\\n-a\\n+b\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n'),
      // A script that only reads names no file, nor does a patch it only prints.
      script('text(await tools.exec_command({ cmd: "cat /work/app/src/other.ts" }));\n'),
      script('text("*** Begin Patch\\n*** Add File: /work/app/fake.md\\n*** End Patch");\n'),
    ], parseCodexLineDetailed);
    expect(transcriptHandoff(events, '/work/app').filesTouched).toEqual(['C:\\work\\app\\src\\new.ts', 'b.md']);
    // A Windows folder, either separator: below it, with git's `/`.
    expect(transcriptHandoff(events, 'C:\\work\\app').filesTouched).toEqual(['src/new.ts', '/work/app/b.md']);
    expect(transcriptHandoff(events, 'c:/work/app/').filesTouched).toEqual(['src/new.ts', '/work/app/b.md']);
  });

  it('reads a rename under its new name, and drops a header the inline head cut short', () => {
    const patch = (inline: string, truncated?: true): TurnEvent => ({ id: inline.slice(-8), kind: 'tool_use', toolUseId: 't', name: 'apply_patch', argSummary: '', input: { n: 0, bytes: 9000, inline, ...(truncated ? { truncated } : {}) } });
    const events = [
      patch('*** Begin Patch\n*** Update File: /work/app/old.ts\n*** Move to: /work/app/new.ts\n@@\n-a\n+b\n*** End Patch'),
      patch('*** Begin Patch\n*** Update File: /work/app/a.ts\n@@\n+x\n*** Update File: /work/app/lo', true),
    ];
    expect(transcriptHandoff(events, '/work/app').filesTouched).toEqual(['a.ts', 'new.ts', 'old.ts']);
  });
});

describe('handoffNoteText', () => {
  const facts = {
    requests: ['keep open tasks past the GC', 'then wire blockedBy'],
    reply: 'The board keeps open tasks. Next is blockedBy.',
    filesTouched: ['src/board.ts', 'plans/board.md'],
    planFiles: ['plans/board.md'],
    repo: 'app',
    branch: 'feat/board',
    files: [{ path: 'src/board.ts', additions: 38, deletions: 6 }],
    transcriptPath: '/home/me/.claude/projects/app/9f2c.jsonl',
    draft: 'also relay the upstream result',
  };

  it('says where, what was asked, the reply, the files and the transcript; the draft only when carried', () => {
    expect(handoffNoteText('Claude Code', facts)).toBe([
      'Continuing work Claude Code started in app, on branch feat/board.',
      'Asked: keep open tasks past the GC',
      'Latest request: then wire blockedBy',
      'Last reply: The board keeps open tasks. Next is blockedBy.',
      'Files touched: src/board.ts (+38 −6), plans/board.md',
      'Full conversation: /home/me/.claude/projects/app/9f2c.jsonl',
      'Check the current changes, then carry on from here.',
    ].join('\n'));
    expect(handoffNoteText('Claude Code', facts, { carryDraft: true }).endsWith('\nUnsent draft: also relay the upstream result')).toBe(true);
    // Nothing known: still a usable note.
    expect(handoffNoteText('Codex CLI', null)).toBe('Continuing work Codex CLI started in this folder.\nCheck the current changes, then carry on from here.');
  });

  it('stays short: requests, the reply end and the file list are capped, keys masked, uncommitted files when none were touched', () => {
    const note = handoffNoteText('Claude Code', {
      requests: [`${'x'.repeat(NOTE_REQUEST_MAX + 50)}`, 'use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'],
      reply: `${'y'.repeat(NOTE_REPLY_MAX)} pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
      filesTouched: Array.from({ length: NOTE_FILES_MAX + 3 }, (_, i) => `src/f${i}.ts`),
    });
    expect(note).toContain(`Asked: ${'x'.repeat(NOTE_REQUEST_MAX)}…\n`);
    expect(note).toContain('Latest request: use the key [redacted]');
    expect(note).not.toMatch(/sk-ant-|ghp_/);
    expect(note).toMatch(/\nLast reply: …y+ pushed with \[redacted\]\n/);
    expect(note).toContain(`Files touched: src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts, src/f5.ts, src/f6.ts, src/f7.ts, …and 3 more\n`);
    expect(note.length).toBeLessThan(1200);
    // A key across the cut is masked before the cut; a cut never splits a surrogate pair.
    const edge = handoffNoteText('Claude Code', { requests: [`${'x'.repeat(NOTE_REQUEST_MAX - 10)} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123`, `${'z'.repeat(NOTE_REQUEST_MAX - 1)}😀 tail`] });
    expect(edge).not.toContain('sk-ant');
    expect(edge).toContain(`Latest request: ${'z'.repeat(NOTE_REQUEST_MAX - 1)}…\n`);
    expect(handoffNoteText('Claude Code', { files: [{ path: 'img.png', additions: null, deletions: null }] })).toContain('\nUncommitted changes: img.png (bin)\n');
  });
});

describe('bringing the work back', () => {
  /** Codex took over: the handoff note, a commit from its shell, a later request, a failed commit, its reply. */
  const CODEX_AFTER = [
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Continuing work Claude Code started in app.' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git commit -am "board: blockedBy"' }) } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'lint ok\n[feat/board 3a91c2e] board: blockedBy\n 2 files changed, 38 insertions(+), 6 deletions(-)' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'now relay the upstream result' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git commit -m relay' }) } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: '[main (root-commit) 7d04b18c9e] relay downstream\n 1 file changed' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: 'Relayed. Export to markdown is still open.' } },
  ];
  /** Claude Code: a Bash commit, the same summary line quoted back in prose, and printed by a command that commits nothing. */
  const CLAUDE_AFTER = [
    { type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git commit -m x' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[feat/board 3a91c2e] board: blockedBy' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: '[feat/board 9999999] not a real commit' }] } },
    { type: 'assistant', uuid: 'a3', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'cat old-log.txt' } }] } },
    { type: 'user', uuid: 'r2', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: '[main 8888888] from a log file' }] } },
  ];

  it('reads the commits an agent made from what its shell printed, once each', () => {
    expect(transcriptCommits(parse(CODEX_AFTER, parseCodexLineDetailed))).toEqual([
      { sha: '3a91c2e', subject: 'board: blockedBy' },
      { sha: '7d04b18', subject: 'relay downstream' },
    ]);
    expect(transcriptCommits([...parse(CLAUDE_AFTER, parseTranscriptLineDetailed), ...parse(CLAUDE_AFTER, parseTranscriptLineDetailed)])).toEqual([
      { sha: '3a91c2e', subject: 'board: blockedBy' },
    ]);
  });

  it('says what the other agent did: the latest request there, commits, files since the handoff, its reply', () => {
    const events = parse(CODEX_AFTER, parseCodexLineDetailed);
    const { requests, reply } = transcriptHandoff(events);
    const note = bringBackNoteText('Codex', {
      // The first request there is the handoff note itself.
      requests: requests.slice(1),
      reply,
      commits: transcriptCommits(events),
      filesTouched: [],
      repo: 'app',
      branch: 'feat/board',
      files: [{ path: 'src/board.ts', additions: 38, deletions: 6 }, { path: 'src/relay.ts', additions: 112, deletions: 0 }],
      transcriptPath: '/home/me/.codex/sessions/rollout-1.jsonl',
    });
    expect(note).toBe([
      'Codex carried on this work in app, on branch feat/board.',
      'Asked there: now relay the upstream result',
      'Commits: 3a91c2e board: blockedBy, 7d04b18 relay downstream',
      'Changes since the handoff: src/board.ts (+38 −6), src/relay.ts (+112 −0)',
      'Last reply: Relayed. Export to markdown is still open.',
      'Full conversation: /home/me/.codex/sessions/rollout-1.jsonl',
      'Check the current changes, then carry on from here.',
    ].join('\n'));
    // Capped: the latest commits, then how many more.
    const many = Array.from({ length: NOTE_COMMITS_MAX + 2 }, (_, i) => ({ sha: `abc000${i}`, subject: `step ${i}` }));
    expect(bringBackNoteText('Codex', { commits: many })).toContain(`Commits: abc0002 step 2, abc0003 step 3, abc0004 step 4, abc0005 step 5, abc0006 step 6, …and 2 more\n`);
    expect(bringBackNoteText('Codex', null)).toBe('Codex carried on this work in this folder.\nCheck the current changes, then carry on from here.');
  });
});

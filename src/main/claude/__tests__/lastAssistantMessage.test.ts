import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionLocation } from '../../../shared/sessionLocation';
import {
  readLastAssistantMessage,
  transcriptFileLives,
  endsWithQuestion,
  type TranscriptCommandRunner,
} from '../lastAssistantMessage';

// The regression these guard: an agent.stop wake used to reach the orchestrator
// with no content, so "finished" and "blocked on a question" were
// indistinguishable without scraping the terminal — where a printed question
// looks exactly like text pending in the input box.

describe('endsWithQuestion', () => {
  it('detects a plain question mark on the last line', () => {
    expect(endsWithQuestion('Did the merge land?')).toBe(true);
  });

  it('detects Korean interrogative endings with no question mark', () => {
    // The common real case: agents in this repo are driven in Korean, where a
    // question routinely ends in -kka/-neunji and carries no '?' at all.
    expect(endsWithQuestion('브랜치 옮겨서 PR 올릴까')).toBe(true);
    expect(endsWithQuestion('이대로 진행해도 되는지')).toBe(true);
  });

  it('looks only at the LAST line', () => {
    // A question mid-report followed by more work is not a block.
    expect(endsWithQuestion('Should I retry?\nRetried, and it passed.')).toBe(false);
    expect(endsWithQuestion('Done.\nShall I merge?')).toBe(true);
  });

  it('sees through trailing markdown emphasis', () => {
    expect(endsWithQuestion('**머지할까?**')).toBe(true);
  });

  it('does not fire on statements', () => {
    expect(endsWithQuestion('Merged as 08be43f.')).toBe(false);
    expect(endsWithQuestion('CI 6/6 통과했다.')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });

  // Both review models flagged these independently: polite -yo and -ni endings
  // appear on ordinary declaratives constantly, and a false positive is worse
  // than a miss — it makes the orchestrator announce a block that does not exist.
  it('does not mistake polite declaratives for questions', () => {
    expect(endsWithQuestion('이제 커밋 메시지를 작성하러 가요')).toBe(false);
    expect(endsWithQuestion('결과는 저장소에 들어가요.')).toBe(false);
    expect(endsWithQuestion('로그를 살펴보니')).toBe(false);
    expect(endsWithQuestion('테스트를 고쳤으니.')).toBe(false);
  });

  it('catches the polite proposal form that plain -kka suffix misses', () => {
    // Polite proposal form (-kka-yo) ends in -yo, not -kka — the most common way
    // an agent asks permission in Korean, and the exact bug class this function exists for.
    expect(endsWithQuestion('이대로 진행할까요')).toBe(true);
    expect(endsWithQuestion('머지할까.')).toBe(true);
  });
});

describe('readLastAssistantMessage', () => {
  let dir: string;
  let file: string;

  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
  const assistantText = (text: string) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-transcript-'));
    file = path.join(dir, 'transcript.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the final assistant message and flags a question', () => {
    fs.writeFileSync(file, assistantText('Working on it.') + assistantText('머지할까?'));
    expect(readLastAssistantMessage(file)).toEqual({
      text: '머지할까?',
      endsWithQuestion: true,
    });
  });

  it('skips tool-only assistant turns to find the last spoken text', () => {
    // A turn that only issued tool calls has no text; the human-facing message
    // is the one before it.
    const toolOnly = line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    fs.writeFileSync(file, assistantText('Shall I merge?') + toolOnly);
    expect(readLastAssistantMessage(file)?.text).toBe('Shall I merge?');
  });

  // The subtlest bug in this file: assistant asks -> human answers -> assistant
  // does tool-only work -> turn ends. Walking back past the human's answer
  // resurrects a settled question and republishes it as a fresh block.
  it('never returns a question the human already answered', () => {
    const humanTurn = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '응 머지해' }] },
    });
    const toolOnly = line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    fs.writeFileSync(file, assistantText('머지할까요') + humanTurn + toolOnly);
    expect(readLastAssistantMessage(file)).toBeNull();
  });

  it('does not treat a tool_result as a human turn', () => {
    // Claude Code records tool results as `user` entries too — stopping on
    // those would blind the reader to the turn's actual closing message.
    const toolResult = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    });
    fs.writeFileSync(file, assistantText('머지할까요') + toolResult);
    expect(readLastAssistantMessage(file)?.text).toBe('머지할까요');
  });

  it('returns null when the human spoke last — nothing is awaiting an answer', () => {
    // The human's turn is the boundary: anything the assistant said before it
    // has been responded to, so there is no open question to report.
    fs.writeFileSync(
      file,
      assistantText('All done.') + line({ type: 'user', message: { role: 'user', content: 'thanks' } }),
    );
    expect(readLastAssistantMessage(file)).toBeNull();
  });

  it('survives a partial leading line from the bounded tail read', () => {
    fs.writeFileSync(file, `{"type":"assist\n${assistantText('Done.')}`);
    expect(readLastAssistantMessage(file)?.text).toBe('Done.');
  });

  it('truncates a long message from the END, keeping the ask', () => {
    const long = `${'x'.repeat(5000)}\nShall I proceed?`;
    fs.writeFileSync(file, assistantText(long));
    const got = readLastAssistantMessage(file);
    expect(got).not.toBeNull();
    expect(got?.text.length).toBeLessThanOrEqual(601);
    expect(got?.text.endsWith('Shall I proceed?')).toBe(true);
    expect(got?.endsWithQuestion).toBe(true);
  });

  // The bounded tail read only seeks when the file exceeds TAIL_BYTES, so a
  // small-file test never exercises the mid-file seek at all. Korean
  // transcripts are full of multi-byte characters; slicing into one must not
  // take down the stop hook.
  it('seeks past a multi-byte boundary on a >256KB transcript without throwing', () => {
    const filler = assistantText(`${'한'.repeat(4000)}`);
    let bulk = '';
    while (Buffer.byteLength(bulk, 'utf8') < 300 * 1024) bulk += filler;
    fs.writeFileSync(file, bulk + assistantText('이대로 진행할까요'));
    const got = readLastAssistantMessage(file);
    expect(got?.text).toBe('이대로 진행할까요');
    expect(got?.endsWithQuestion).toBe(true);
  });

  it('decodes only the bytes actually read', () => {
    // A short read (concurrent truncation) must not leave zero-fill that
    // corrupts the final record.
    fs.writeFileSync(file, assistantText('Done.'));
    expect(readLastAssistantMessage(file)?.text).toBe('Done.');
  });

  it('refuses a non-regular file rather than blocking on it', () => {
    // openSync on a FIFO blocks the main process forever; the hook budget
    // cannot cancel a blocked syscall.
    const fifo = path.join(dir, 'fifo');
    fs.mkdirSync(fifo);
    expect(readLastAssistantMessage(fifo)).toBeNull();
  });

  it('refuses a symlink instead of following it', () => {
    const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isFile: () => false,
      isSymbolicLink: () => true,
    } as fs.Stats);
    expect(readLastAssistantMessage('link.jsonl')).toBeNull();
    expect(transcriptFileLives('link.jsonl')).toBe(false);
    lstat.mockRestore();
  });

  it('refuses a device rather than attempting a read', () => {
    const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isFile: () => false,
    } as fs.Stats);
    expect(readLastAssistantMessage('device')).toBeNull();
    expect(transcriptFileLives('device')).toBe(false);
    lstat.mockRestore();
  });

  it('returns null rather than throwing on a missing or garbage file', () => {
    expect(readLastAssistantMessage(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(file, 'not json at all\n{also not\n');
    expect(readLastAssistantMessage(file)).toBeNull();
  });
});

describe('WSL transcript reads', () => {
  const location: SessionLocation = {
    domain: 'wsl',
    cwd: '/work/repo',
    shell: 'wsl.exe',
    distro: 'Ubuntu-24.04',
  };
  const context = { location, activeSession: { sessionId: 'pty-1', active: true as const, distro: 'Ubuntu-24.04' } };
  const assistantText = (text: string) =>
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;

  it('uses a structured distro-bound command and caps timeout and output', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from(assistantText('Proceed?')));
    expect(readLastAssistantMessage('/home/me/transcript.jsonl', context, run)).toEqual({
      text: 'Proceed?',
      endsWithQuestion: true,
    });
    const [file, args, options] = run.mock.calls[0];
    expect(file).toBe('wsl.exe');
    expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/work/repo', '--exec', 'python3']);
    expect(args.at(-1)).toBe('/home/me/transcript.jsonl');
    expect(options).toMatchObject({ timeout: 750, maxBuffer: 256 * 1024, windowsHide: true });
  });

  it('fails softly when the bounded WSL command times out', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockImplementation(() => {
      const err = new Error('timed out');
      Object.assign(err, { code: 'ETIMEDOUT' });
      throw err;
    });
    expect(readLastAssistantMessage('/home/me/transcript.jsonl', context, run)).toBeNull();
    expect(transcriptFileLives('/home/me/transcript.jsonl', context, run)).toBe(false);
  });

  it('rejects a location/distro mismatch without executing anything', () => {
    const run = vi.fn<TranscriptCommandRunner>();
    const mismatched = {
      location,
      activeSession: { sessionId: 'pty-1', active: true as const, distro: 'Debian' },
    };
    expect(readLastAssistantMessage('/home/me/transcript.jsonl', mismatched, run)).toBeNull();
    expect(transcriptFileLives('/home/me/transcript.jsonl', mismatched, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('treats only an explicit regular-file probe result as live', () => {
    const live = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('1'));
    const unsafe = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('0'));
    expect(transcriptFileLives('/home/me/transcript.jsonl', context, live)).toBe(true);
    expect(transcriptFileLives('/home/me/transcript.jsonl', context, unsafe)).toBe(false);
  });
});

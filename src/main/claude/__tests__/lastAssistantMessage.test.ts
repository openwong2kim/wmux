import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionLocation } from '../../../shared/sessionLocation';
import {
  readLastAssistantMessage,
  transcriptFileLives,
  endsWithQuestion,
  __resetTranscriptProbeCache,
  __whenTranscriptProbesIdle,
  type AsyncTranscriptCommandRunner,
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

  beforeEach(() => __resetTranscriptProbeCache());

  it('falls back to the guarded host UNC reader when guest python is missing', () => {
    const raw = Buffer.from(assistantText('Proceed?'));
    const stats = { isFile: () => true, size: raw.length } as fs.Stats;
    const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue(stats);
    const open = vi.spyOn(fs, 'openSync').mockReturnValue(7);
    const fstat = vi.spyOn(fs, 'fstatSync').mockReturnValue(stats);
    const read = vi.spyOn(fs, 'readSync').mockImplementation(
      ((_fd: number, buffer: Buffer) => {
        raw.copy(buffer);
        return raw.length;
      }) as typeof fs.readSync,
    );
    const close = vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
    const run = vi.fn<TranscriptCommandRunner>().mockImplementation(() => {
      throw Object.assign(new Error('execvpe(python3) failed: No such file or directory'), {
        stderr: Buffer.from('execvpe(python3) failed: No such file or directory'),
      });
    });
    const uncPath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\transcript.jsonl';
    try {
      expect(readLastAssistantMessage('/home/me/transcript.jsonl', context, run)).toEqual({
        text: 'Proceed?',
        endsWithQuestion: true,
      });
      expect(lstat).toHaveBeenCalledWith(uncPath);
      expect(open.mock.calls[0][0]).toBe(uncPath);
      // Isolate the probe from the tail read above. Without this the UNC
      // assertions are already satisfied by readLastAssistantMessage, so a probe
      // that silently stopped falling back — and returned "unproven" instead of
      // consulting the bridge — would still pass.
      lstat.mockClear();
      expect(transcriptFileLives('/home/me/transcript.jsonl', context, run)).toBe(true);
      expect(lstat).toHaveBeenCalledWith(uncPath);
    } finally {
      lstat.mockRestore();
      open.mockRestore();
      fstat.mockRestore();
      read.mockRestore();
      close.mockRestore();
    }
  });

  it('treats a timed-out probe as unproven, not as absent', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockImplementation(() => {
      const err = new Error('timed out');
      Object.assign(err, { code: 'ETIMEDOUT' });
      throw err;
    });
    // A tail read still fails softly — there is no message to report.
    expect(readLastAssistantMessage('/home/me/transcript.jsonl', context, run)).toBeNull();
    // Existence is different. A WSL distro cold-booting past the 750 ms budget
    // cannot answer, and reporting absence there dropped the exact
    // `--resume <id>` and restarted the agent without its conversation.
    expect(transcriptFileLives('/home/me/transcript.jsonl', context, run)).toBe(true);
    // Nothing was recorded, so the next poll asks again rather than serving a
    // guess for a full TTL.
    expect(transcriptFileLives('/home/me/transcript.jsonl', context, run)).toBe(true);
  });

  it('rejects a location/distro mismatch without executing anything', () => {
    const run = vi.fn<TranscriptCommandRunner>();
    const mismatched = {
      location,
      activeSession: { sessionId: 'pty-1', active: true as const, distro: 'Debian' },
    };
    expect(readLastAssistantMessage('/home/me/mismatch.jsonl', mismatched, run)).toBeNull();
    expect(transcriptFileLives('/home/me/mismatch.jsonl', mismatched, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('treats an unresolved distribution as unproven, unlike a mismatch', () => {
    const run = vi.fn<TranscriptCommandRunner>();
    // A WSL pane recovered after a reboot knows it is WSL but has not resolved
    // *which* distribution yet. That refusal happens before anything can look at
    // the file, so unlike a mismatch it is not evidence the transcript is gone —
    // and reading it as absence is what dropped the exact `--resume <id>`.
    const unresolved = {
      location: { domain: 'wsl' as const, cwd: '/work/repo', shell: 'wsl.exe' },
      activeSession: { sessionId: 'pty-3', active: true as const },
    };
    expect(transcriptFileLives('/home/me/unresolved.jsonl', unresolved, run)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('refreshes a stale answer out of band through the injected runner', async () => {
    // The refresh used to be gated on the runner being the production function,
    // so an injected one could never drive it and none of this was reachable.
    vi.useFakeTimers();
    try {
      const sync = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('1'));
      const async = vi.fn<AsyncTranscriptCommandRunner>().mockResolvedValue(Buffer.from('0'));
      const prober = { sync, async };

      expect(transcriptFileLives('/home/me/stale.jsonl', context, prober)).toBe(true);
      vi.setSystemTime(Date.now() + 31_000);

      // The stale answer comes back without waiting for the refresh.
      expect(transcriptFileLives('/home/me/stale.jsonl', context, prober)).toBe(true);
      expect(async).toHaveBeenCalledTimes(1);
      // One command constructor for both paths: the refresh spells the same
      // file, args and bounds as the blocking probe did.
      expect(async.mock.calls[0]).toEqual(sync.mock.calls[0]);

      await __whenTranscriptProbesIdle();
      expect(transcriptFileLives('/home/me/stale.jsonl', context, prober)).toBe(false);
      // Still exactly one blocking probe across all three polls.
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats only an explicit regular-file probe result as live', () => {
    const live = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('1'));
    const unsafe = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('0'));
    expect(transcriptFileLives('/home/me/live.jsonl', context, live)).toBe(true);
    expect(transcriptFileLives('/home/me/unsafe.jsonl', context, unsafe)).toBe(false);
  });
});

describe('MSYS transcript paths', () => {
  const context = {
    location: {
      domain: 'msys' as const,
      cwd: '/c/dev/repo',
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
    },
    activeSession: { sessionId: 'pty-msys', active: true as const },
  };

  it('converts a drive-rooted MSYS path before the host liveness probe', () => {
    const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isFile: () => true,
    } as fs.Stats);
    try {
      expect(transcriptFileLives('/c/Users/me/session.jsonl', context)).toBe(true);
      expect(lstat).toHaveBeenCalledWith('C:\\Users\\me\\session.jsonl');
    } finally {
      lstat.mockRestore();
    }
  });

  it('converts a drive-rooted MSYS path before reading its bounded host tail', () => {
    const raw = Buffer.from(
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Proceed?' }] },
      })}\n`,
    );
    const stats = { isFile: () => true, size: raw.length } as fs.Stats;
    const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue(stats);
    const open = vi.spyOn(fs, 'openSync').mockReturnValue(7);
    const fstat = vi.spyOn(fs, 'fstatSync').mockReturnValue(stats);
    const read = vi.spyOn(fs, 'readSync').mockImplementation(
      ((_fd: number, buffer: Buffer) => {
        raw.copy(buffer);
        return raw.length;
      }) as typeof fs.readSync,
    );
    const close = vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
    try {
      expect(readLastAssistantMessage('/c/Users/me/session.jsonl', context)).toEqual({
        text: 'Proceed?',
        endsWithQuestion: true,
      });
      expect(lstat).toHaveBeenCalledWith('C:\\Users\\me\\session.jsonl');
      expect(open.mock.calls[0][0]).toBe('C:\\Users\\me\\session.jsonl');
    } finally {
      lstat.mockRestore();
      open.mockRestore();
      fstat.mockRestore();
      read.mockRestore();
      close.mockRestore();
    }
  });

  it('fails softly for an MSYS path without a drive mapping', () => {
    const lstat = vi.spyOn(fs, 'lstatSync');
    expect(transcriptFileLives('/usr/local/session.jsonl', context)).toBe(false);
    expect(readLastAssistantMessage('/usr/local/session.jsonl', context)).toBeNull();
    expect(lstat).not.toHaveBeenCalled();
    lstat.mockRestore();
  });
});

/**
 * The daemon calls transcriptFileLives from its listSessions handler — a
 * per-poll stat. On the WSL branch that spawns wsl.exe and blocks for up to
 * 750 ms, so N WSL panes would stall the daemon event loop N × 750 ms on every
 * poll, delaying PTY data forwarding and every other RPC.
 */
describe('WSL transcript probe caching', () => {
  const location: SessionLocation = {
    domain: 'wsl',
    cwd: '/work/repo',
    shell: 'wsl.exe',
    distro: 'Ubuntu-24.04',
  };
  const context = {
    location,
    activeSession: { sessionId: 'pty-1', active: true as const, distro: 'Ubuntu-24.04' },
  };

  beforeEach(() => __resetTranscriptProbeCache());
  afterEach(() => __resetTranscriptProbeCache());

  it('resolves the first probe for real, then serves repeat polls from cache', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('1'));
    for (let i = 0; i < 5; i += 1) {
      expect(transcriptFileLives('/home/me/t.jsonl', context, run)).toBe(true);
    }
    // Without the cache this is 5 blocking wsl.exe spawns on one daemon poll.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('caches a negative answer too, so a dead transcript is not re-probed', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('0'));
    expect(transcriptFileLives('/home/me/gone.jsonl', context, run)).toBe(false);
    expect(transcriptFileLives('/home/me/gone.jsonl', context, run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never caches across transcript paths', () => {
    const run = vi.fn<TranscriptCommandRunner>().mockReturnValue(Buffer.from('1'));
    transcriptFileLives('/home/me/a.jsonl', context, run);
    transcriptFileLives('/home/me/b.jsonl', context, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per location, so two distros never share an answer', () => {
    const ubuntu = { ...context };
    const debian = {
      location: { ...location, distro: 'Debian' },
      activeSession: { sessionId: 'pty-2', active: true as const, distro: 'Debian' },
    };
    const live: TranscriptCommandRunner = () => Buffer.from('1');
    const dead: TranscriptCommandRunner = () => Buffer.from('0');
    expect(transcriptFileLives('/home/me/t.jsonl', ubuntu, live)).toBe(true);
    expect(transcriptFileLives('/home/me/t.jsonl', debian, dead)).toBe(false);
  });
});

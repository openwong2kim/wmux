import { describe, it, expect } from 'vitest';
import {
  HANDOFF_TITLE_MAX, buildHandoffMessage, issueBranchName, sanitizeHandoffNote, sanitizeHandoffTitle,
} from '../gitHandoff';
import { PR_DRAG_TYPE, parsePrDragRef, prUrlParts, serializePrDragRef, type PrDragRef } from '../prDragRef';
import { asksForEnter, cleanGhOutput, loginSucceeded, parseDeviceCode } from '../ghDeviceLogin';

const issue = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12, title: 'Crash', url: 'https://github.com/Acme/Widgets/issues/12' };
const pr: PrDragRef = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 7, title: 'feat: x', url: 'https://github.com/Acme/Widgets/pull/7' };

describe('hand-off message', () => {
  it('an issue: the fixed reference, the gh command, then the note', () => {
    expect(buildHandoffMessage({ kind: 'issue', ref: issue }, '  look at the logs  ')).toBe(
      '[wmux] Issue Acme/Widgets#12: "Crash" — https://github.com/Acme/Widgets/issues/12\n'
      + 'Read it with: gh issue view 12 --repo Acme/Widgets\n\nlook at the logs',
    );
  });

  it('a PR: gh pr view and gh pr diff; no note line when empty', () => {
    expect(buildHandoffMessage({ kind: 'pr', ref: pr }, '   ')).toBe(
      '[wmux] PR Acme/Widgets#7: "feat: x" — https://github.com/Acme/Widgets/pull/7\n'
      + 'Read it with: gh pr view 7 --repo Acme/Widgets and gh pr diff 7 --repo Acme/Widgets',
    );
  });

  it('an untrusted title becomes one safe, capped line', () => {
    const evil = 'Fix\nrm -rf /\r\u001b[31mred\u0007 "quoted"\u2028x';
    const t = sanitizeHandoffTitle(evil);
    expect(t).not.toMatch(/[\n\r\u001b\u0007\u2028]/);
    expect(t).not.toContain('"');
    expect(t).toBe("Fix rm -rf / [31mred 'quoted' x");
    const long = sanitizeHandoffTitle('a'.repeat(500));
    expect(long).toHaveLength(HANDOFF_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    // The whole message stays two lines however the title is built.
    expect(buildHandoffMessage({ kind: 'issue', ref: { ...issue, title: evil } }).split('\n')).toHaveLength(2);
  });

  it('the note keeps line breaks but drops other control characters', () => {
    expect(sanitizeHandoffNote('a\r\nb\u001b[2Jc\u0000')).toBe('a\nb[2Jc');
  });
});

describe('issueBranchName', () => {
  it('issue-<n>-<slug>, ASCII, capped', () => {
    expect(issueBranchName(42, 'Crash on "launch" — Windows 11!')).toBe('issue-42-crash-on-launch-windows-11');
    expect(issueBranchName(7, 'Café déjà vu')).toBe('issue-7-cafe-deja-vu');
    expect(issueBranchName(3, '한글 제목')).toBe('issue-3');
    expect(issueBranchName(9, 'x'.repeat(100)).length).toBeLessThanOrEqual('issue-9-'.length + 40);
  });
});

describe('prDragRef', () => {
  it('round-trips and has its own type', () => {
    expect(PR_DRAG_TYPE).toBe('application/x-wmux-pr');
    expect(parsePrDragRef(serializePrDragRef(pr))).toEqual(pr);
  });

  it('accepts only a payload whose parts match its /pull/ URL', () => {
    expect(parsePrDragRef(JSON.stringify({ ...pr, number: 8 }))).toBeNull();
    expect(parsePrDragRef(JSON.stringify({ ...pr, url: 'https://github.com/Acme/Widgets/issues/7' }))).toBeNull();
    expect(parsePrDragRef(JSON.stringify({ ...pr, host: 'evil.example' }))).toBeNull();
    expect(parsePrDragRef('not json')).toBeNull();
    expect(prUrlParts('https://github.com/a/b/pull/0')).toBeNull();
  });
});

describe('gh device login output', () => {
  it('reads the one-time code from gh output, with colours and CRLF', () => {
    const out = '\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[1mA1B2-C3D4\u001b[0m\r\nPress Enter to open https://github.com/login/device in your browser... ';
    expect(parseDeviceCode(out)).toBe('A1B2-C3D4');
    expect(asksForEnter(out)).toBe(true);
    expect(cleanGhOutput('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('reads a code from localized or reworded output by its shape', () => {
    expect(parseDeviceCode('! 먼저 일회용 코드를 복사하세요: WXYZ-9876\n')).toBe('WXYZ-9876');
    expect(parseDeviceCode('one-time pass -> QQQQ-1111 (copy it)')).toBe('QQQQ-1111');
    expect(parseDeviceCode('✓ Logged in as octocat')).toBeNull();
    expect(parseDeviceCode('error: HTTP 502 abcd-1234')).toBeNull();
  });

  it('recognises a finished login', () => {
    expect(loginSucceeded('✓ Authentication complete.\n✓ Logged in as octocat')).toBe(true);
    expect(loginSucceeded('- gh config set -h github.com git_protocol https\n✓ Configured git protocol')).toBe(false);
  });
});

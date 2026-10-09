import { describe, expect, it } from 'vitest';
import { LOCAL_PC_ID } from '../../../../shared/pcRail';
import { badgeText, cyclePc, monogram, pcBadge, pcIconState, pcShortcutAction, pcShortcutTarget } from '../pcRailModel';

describe('monogram', () => {
  it('takes the initials of two words, or two letters of one', () => {
    expect(monogram('office-mac')).toBe('OM');
    expect(monogram('Studio Mini')).toBe('SM');
    expect(monogram('studio')).toBe('ST');
    expect(monogram('mini.local')).toBe('ML');
  });
  it('never splits a code point and falls back for an empty label', () => {
    expect(monogram('회사맥')).toBe('회사');
    expect(monogram('   ')).toBe('?');
  });
});

describe('cyclePc', () => {
  const hosts = ['a', 'b'];
  it('wraps with this computer first', () => {
    expect(cyclePc(hosts, LOCAL_PC_ID, 1)).toBe('a');
    expect(cyclePc(hosts, 'b', 1)).toBe(LOCAL_PC_ID);
    expect(cyclePc(hosts, LOCAL_PC_ID, -1)).toBe('b');
  });
  it('treats an unknown active id as this computer', () => {
    expect(cyclePc(hosts, 'gone', 1)).toBe('a');
  });
});

describe('pcBadge', () => {
  it('hides every mark on the selected computer', () => {
    expect(pcBadge({ needsYou: 3, finished: 1 }, true)).toEqual({ kind: 'none' });
  });
  it('prefers needs-you, then the done dot, and draws nothing at zero', () => {
    expect(pcBadge({ needsYou: 2, finished: 1 }, false)).toEqual({ kind: 'needs-you', count: 2 });
    expect(pcBadge({ needsYou: 0, finished: 1 }, false)).toEqual({ kind: 'finished' });
    expect(pcBadge({ needsYou: 0, finished: 0 }, false)).toEqual({ kind: 'none' });
  });
  it('caps the digits', () => {
    expect(badgeText(150)).toBe('99+');
  });
});

describe('pcIconState', () => {
  it('never draws a host online before its first list', () => {
    expect(pcIconState({ status: 'reachable', lastSeenAt: null })).toBe('unchecked');
    expect(pcIconState({ status: 'reachable', lastSeenAt: 1 })).toBe('online');
    expect(pcIconState({ status: 'unreachable', lastSeenAt: null })).toBe('offline');
    expect(pcIconState({ status: 'needs-repair', lastSeenAt: 1 })).toBe('needs-repair');
  });
});

describe('PC shortcuts', () => {
  it('maps the default chords and moves the selection', () => {
    expect(pcShortcutAction('Shift+Alt+ArrowDown')).toBe('nextPc');
    expect(pcShortcutAction('Alt+ArrowDown')).toBeUndefined();
    expect(pcShortcutAction(null)).toBeUndefined();
    expect(pcShortcutTarget('nextPc', ['a'], LOCAL_PC_ID)).toBe('a');
    expect(pcShortcutTarget('prevPc', ['a'], LOCAL_PC_ID)).toBe('a');
    expect(pcShortcutTarget('thisPc', ['a'], 'a')).toBe(LOCAL_PC_ID);
  });
});

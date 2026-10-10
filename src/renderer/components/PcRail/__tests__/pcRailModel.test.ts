import { describe, expect, it } from 'vitest';
import { LOCAL_PC_ID } from '../../../../shared/pcRail';
import { accessLines, badgeText, cyclePc, isPcRailAction, monogram, pcBadge, pcIconState, pcRailClaimsKey, pcShortcutTarget } from '../pcRailModel';

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
  it('moves the selection', () => {
    expect(pcShortcutTarget('nextPc', ['a'], LOCAL_PC_ID)).toBe('a');
    expect(pcShortcutTarget('prevPc', ['a'], LOCAL_PC_ID)).toBe('a');
    expect(pcShortcutTarget('thisPc', ['a'], 'a')).toBe(LOCAL_PC_ID);
  });
  it('claims a chord only with a paired computer and no custom keybinding on it', () => {
    const e = { ctrlKey: false, shiftKey: true, altKey: true, key: 'ArrowDown' };
    expect(isPcRailAction('nextPc')).toBe(true);
    expect(isPcRailAction('nextWorkspace')).toBe(false);
    expect(pcRailClaimsKey({ pcRailHosts: [], customKeybindings: [] }, e)).toBe(false);
    expect(pcRailClaimsKey({ pcRailHosts: [{}], customKeybindings: [] }, e)).toBe(true);
    expect(pcRailClaimsKey({ pcRailHosts: [{}], customKeybindings: [{ key: 'Shift+Alt+ArrowDown' }] }, e)).toBe(false);
  });
});

describe('accessLines', () => {
  const t = (k: string) => k;
  const host = { id: 'h', label: 'mac', kind: 'web-paired' as const, status: 'reachable' as const, attention: { needsYou: 0, finished: 0 }, lastSeenAt: 1, muted: false };
  it('promises a revoke path only for a known credential kind', () => {
    expect(accessLines({ ...host, tokenKind: 'device' }, t)).toEqual(['pcRail.access.revokeHint']);
    expect(accessLines({ ...host, tokenKind: 'operator' }, t)).toEqual(['pcRail.operatorTokenHint']);
    expect(accessLines({ ...host, allowInput: true }, t)).toEqual(['pcRail.access.canType', 'pcRail.access.revokeHintUnknown']);
  });
});

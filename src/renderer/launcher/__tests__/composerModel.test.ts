import { describe, expect, it } from 'vitest';
import { agentValue, composerKeyAction, initialWorkspace, parseAgentValue } from '../composerModel';

const press = (key: string, extra: Partial<{ shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number }> = {}) =>
  composerKeyAction({ key, shiftKey: false, altKey: false, isComposing: false, ...extra });

describe('composerKeyAction', () => {
  it('Enter starts, Shift+Enter is a newline, Escape dismisses', () => {
    expect(press('Enter')).toBe('submit');
    expect(press('Enter', { shiftKey: true })).toBeNull();
    expect(press('Escape')).toBe('dismiss');
    expect(press('a')).toBeNull();
  });

  it('never fires while an IME composition is open', () => {
    expect(press('Enter', { isComposing: true })).toBeNull();
    expect(press('Enter', { keyCode: 229 })).toBeNull();
    expect(press('Escape', { isComposing: true })).toBeNull();
  });
});

describe('agent values', () => {
  it('round-trips every kind', () => {
    for (const agent of [{ kind: 'default' }, { kind: 'role', role: 'Reviewer' }, { kind: 'agent', agent: 'codex' }] as const) {
      expect(parseAgentValue(agentValue(agent))).toEqual(agent);
    }
  });
});

describe('initialWorkspace', () => {
  const workspaces = [
    { id: 'a', name: 'A', cwd: '' },
    { id: 'b', name: 'B', cwd: '/b' },
    { id: 'c', name: 'C', cwd: '/c' },
  ];
  it('prefers the remembered one, then the active one, then the first with a folder', () => {
    expect(initialWorkspace(workspaces, 'c', 'b')).toBe('c');
    expect(initialWorkspace(workspaces, 'gone', 'b')).toBe('b');
    expect(initialWorkspace(workspaces, undefined, 'a')).toBe('b');
    expect(initialWorkspace([], undefined, undefined)).toBeUndefined();
  });
});

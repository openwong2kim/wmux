import { describe, it, expect, vi } from 'vitest';
import { classifyPaneRef, resolvePaneRef, resolvePtyRef, resolvePaneIdRef } from '../paneTarget';

const target = {
  workspaceId: 'ws-1', paneId: 'pane-1', surfaceId: 'surface-1', ptyId: 'daemon-1a2b3c4d',
  paneName: 'backend', paneTag: '#w1-2',
};

describe('classifyPaneRef', () => {
  it.each([
    ['#w1-2', 'name'],
    ['#backend', 'name'],
    ['pane-3f1c0d7e-1111-4222-8333-444455556666', 'id'],
    ['surface-3f1c0d7e-1111-4222-8333-444455556666', 'id'],
    ['daemon-1a2b3c4d', 'id'],
    ['pty-3', 'id'],
    ['brain-0123abcd', 'id'],
    ['auto-run-1', 'id'],
    ['remote:host-1:sess-1', 'id'],
    // Legal labels that merely share an id prefix are still names.
    ['pane-build', 'maybe'],
    ['daemon-api', 'maybe'],
    ['pty-runner', 'maybe'],
    ['w1-2', 'maybe'],
    ['backend', 'maybe'],
  ])('%s → %s', (value, kind) => {
    expect(classifyPaneRef(value)).toBe(kind);
  });
});

describe('resolvePaneRef', () => {
  it('never sends an id through name resolution', async () => {
    const rpc = vi.fn();
    expect(await resolvePaneRef('daemon-1a2b3c4d', rpc)).toBeNull();
    expect(await resolvePaneRef(undefined, rpc)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('resolves a #name and a bare name through pane.resolveName', async () => {
    const rpc = vi.fn(async () => ({ ok: true, target }));
    expect(await resolvePaneRef('#backend', rpc)).toEqual(target);
    expect(await resolvePtyRef('w1-2', rpc)).toBe('daemon-1a2b3c4d');
    expect(await resolvePaneIdRef('#w1-2', rpc)).toBe('pane-1');
    expect(rpc).toHaveBeenCalledWith('pane.resolveName', { name: '#backend' });
  });

  it('a #name miss is an error; a bare miss falls back to the raw value', async () => {
    const rpc = vi.fn(async () => ({ ok: false, reason: 'not_found', error: 'no pane named "#nope"' }));
    await expect(resolvePaneRef('#nope', rpc)).rejects.toThrow('no pane named "#nope"');
    expect(await resolvePtyRef('legacy_id', rpc)).toBe('legacy_id');
  });

  it('an ambiguous name is an error even without #', async () => {
    const rpc = vi.fn(async () => ({ ok: false, reason: 'ambiguous', error: 'pane name "dup" matches 2 panes' }));
    await expect(resolvePaneRef('dup', rpc)).rejects.toThrow('matches 2 panes');
  });

  it('a bare value keeps working when wmux cannot resolve names', async () => {
    const rpc = vi.fn(async () => { throw new Error('unknown method'); });
    expect(await resolvePaneIdRef('custom-pane', rpc)).toBe('custom-pane');
    await expect(resolvePaneRef('#w1-2', rpc)).rejects.toThrow('unknown method');
  });

  it('refuses a pane with no terminal for a pty parameter', async () => {
    const rpc = vi.fn(async () => ({ ok: true, target: { ...target, ptyId: '' } }));
    await expect(resolvePtyRef('#w1-2', rpc)).rejects.toThrow('#w1-2 has no local terminal');
  });
});

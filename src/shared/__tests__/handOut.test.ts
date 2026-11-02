import { describe, expect, it } from 'vitest';
import {
  HAND_OUT_LIMITS,
  buildHandOutMessage,
  folderWithin,
  handOutBranchName,
  handOutStateOf,
  normalizeFolder,
  parseHandOutAdd,
  parseHandOutItem,
  type HandOutItem,
} from '../handOut';
import type { WorkLink } from '../workLink';

const ID = 'ho-0b5f3c4e-1d2a-4c6b-9e8f-7a6b5c4d3e2f';

function link(over: Partial<WorkLink>): WorkLink {
  return {
    id: 'link-1', origin: 'hand-out', handOutId: ID, owner: { workspaceId: 'ws-1' }, state: 'running',
    decisionIds: [], createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('normalizeFolder', () => {
  it('drops trailing separators and keeps a root', () => {
    expect(normalizeFolder(' /repo/app/ ')).toBe('/repo/app');
    expect(normalizeFolder('/')).toBe('/');
    expect(normalizeFolder('///')).toBe('/');
    expect(normalizeFolder('C:\\work\\app\\')).toBe('C:\\work\\app');
    expect(normalizeFolder('C:\\')).toBe('C:\\');
    expect(normalizeFolder('C:/')).toBe('C:\\');
  });
});

describe('folderWithin', () => {
  it('POSIX: the folder itself and folders inside it, case kept', () => {
    expect(folderWithin('/a/b', '/a/b/')).toBe(true);
    expect(folderWithin('/a/b/c', '/a/b')).toBe(true);
    expect(folderWithin('/x', '/')).toBe(true);
    expect(folderWithin('/A/b', '/a')).toBe(false);
  });

  it('a sibling that shares a prefix is not inside', () => {
    expect(folderWithin('/a/bc', '/a/b')).toBe(false);
    expect(folderWithin('C:\\a\\bc', 'C:\\a\\b')).toBe(false);
  });

  it('Windows: either separator, any case', () => {
    expect(folderWithin('c:/Users/me/repo', 'C:\\Users\\Me')).toBe(true);
    expect(folderWithin('C:\\Users\\Me\\Repo\\', 'c:/users/me/repo')).toBe(true);
    expect(folderWithin('C:\\x', 'C:\\')).toBe(true);
    expect(folderWithin('D:\\x', 'C:\\')).toBe(false);
    expect(folderWithin('\\\\srv\\share\\x', '\\\\SRV\\share')).toBe(true);
  });
});

describe('parseHandOutAdd', () => {
  it('cleans a good add: one-line title, folder without its trailing separator', () => {
    expect(parseHandOutAdd({ title: '  Fix\nthe   crash ', folder: '/repo/app/', agent: 'claude', note: 'start with the logs', extra: 1 }))
      .toEqual({ title: 'Fix the crash', folder: '/repo/app', agent: 'claude', note: 'start with the logs' });
    expect(parseHandOutAdd({ title: 'x', folder: 'C:\\work', agent: '' })).toEqual({ title: 'x', folder: 'C:\\work' });
  });

  it('caps the title and the note', () => {
    const add = parseHandOutAdd({ title: 't'.repeat(500), folder: '/r', note: 'n'.repeat(5000) });
    expect(add?.title).toHaveLength(HAND_OUT_LIMITS.MAX_TITLE);
    expect(add?.note?.length).toBeLessThanOrEqual(HAND_OUT_LIMITS.MAX_NOTE);
  });

  it.each([
    ['an empty title', { title: '  \u200b ', folder: '/r' }],
    ['a relative folder', { title: 't', folder: 'repo/app' }],
    ['a folder with NUL', { title: 't', folder: '/r\0x' }],
    ['a folder past the cap', { title: 't', folder: `/${'a'.repeat(HAND_OUT_LIMITS.MAX_FOLDER)}` }],
    ['a bad agent', { title: 't', folder: '/r', agent: 'Bad Slug' }],
    ['a non-text note', { title: 't', folder: '/r', note: 5 }],
    ['no folder', { title: 't' }],
    ['not an object', 'title'],
  ])('refuses %s', (_label, raw) => {
    expect(parseHandOutAdd(raw)).toBeNull();
  });
});

describe('parseHandOutItem', () => {
  const stored = { id: ID, title: 'Fix it', folder: '/repo', addedBy: { kind: 'owner' }, createdAt: 5 };

  it('reads a stored item and drops unknown keys', () => {
    expect(parseHandOutItem({ ...stored, state: 'out' })).toEqual(stored);
    expect(parseHandOutItem({ ...stored, addedBy: { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: `w1-2\n${'x'.repeat(300)}` } })?.addedBy)
      .toEqual({ kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: `w1-2 ${'x'.repeat(95)}` });
  });

  it.each([
    ['a bad id', { ...stored, id: 'ho-1' }],
    ['no time', { ...stored, createdAt: -1 }],
    ['an unknown author', { ...stored, addedBy: { kind: 'bot' } }],
    ['a pane author without a workspace', { ...stored, addedBy: { kind: 'pane', paneId: 'pane-1' } }],
    ['a bad folder', { ...stored, folder: 'repo' }],
  ])('refuses %s', (_label, raw) => {
    expect(parseHandOutItem(raw)).toBeNull();
  });
});

describe('handOutStateOf', () => {
  it('is open with no link of its own', () => {
    expect(handOutStateOf(ID, [])).toEqual({ state: 'open' });
    expect(handOutStateOf(ID, [link({ handOutId: undefined, origin: 'manual' })])).toEqual({ state: 'open' });
  });

  it('is out while a link is live, done once it is done', () => {
    expect(handOutStateOf(ID, [link({ state: 'queued' })])).toEqual({ state: 'out', linkId: 'link-1' });
    expect(handOutStateOf(ID, [link({ state: 'needs-you', reason: 'decision' })])).toEqual({ state: 'out', linkId: 'link-1' });
    expect(handOutStateOf(ID, [link({ state: 'done' })])).toEqual({ state: 'done', linkId: 'link-1' });
  });

  it('an abandoned send puts it back, and a newer live pick takes it out again', () => {
    const abandoned = link({ id: 'link-old', state: 'abandoned', createdAt: 1 });
    expect(handOutStateOf(ID, [abandoned])).toEqual({ state: 'open' });
    expect(handOutStateOf(ID, [abandoned, link({ id: 'link-new', state: 'running', createdAt: 2 })]))
      .toEqual({ state: 'out', linkId: 'link-new' });
  });

  it('a failed task puts it back; work blocked on CI or review keeps it out', () => {
    expect(handOutStateOf(ID, [link({ state: 'blocked', reason: 'task-failed' })])).toEqual({ state: 'open' });
    expect(handOutStateOf(ID, [link({ state: 'blocked', reason: 'ci-failing' })])).toEqual({ state: 'out', linkId: 'link-1' });
  });
});

describe('buildHandOutMessage', () => {
  const item: HandOutItem = {
    id: ID, title: 'Fix $(id) "now"', folder: '/repo/app', agent: 'codex', note: 'See the log\nfirst.',
    addedBy: { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1', name: 'backend' }, createdAt: 1,
  };

  it('names the item, its folder, who added it and its note; nothing in the title expands', () => {
    expect(buildHandOutMessage(item)).toBe(
      "[wmux] To hand out: \"Fix (id) 'now'\"\nFolder: /repo/app\nAdded by #backend; asks for codex.\n\nSee the log\nfirst.",
    );
  });

  it('asks a CEO to brief a seat, and names the owner', () => {
    const msg = buildHandOutMessage({ ...item, agent: undefined, note: undefined, addedBy: { kind: 'owner' } }, { company: true });
    expect(msg.split('\n')).toEqual([
      "[wmux] To hand out: \"Fix (id) 'now'\"",
      'Folder: /repo/app',
      'Added by the owner.',
      'Brief one of your seats with it, and finish this task once that work is checked.',
    ]);
  });
});

describe('handOutBranchName', () => {
  it('hand-out, the issue branch slug, then the suffix', () => {
    expect(handOutBranchName('Fix the crash on launch!', 'a1b2c3')).toBe('hand-out-fix-the-crash-on-launch-a1b2c3');
    expect(handOutBranchName('Café déjà vu', 'a1b2c3')).toBe('hand-out-cafe-deja-vu-a1b2c3');
    expect(handOutBranchName('x'.repeat(80), 'a1b2c3')).toBe(`hand-out-${'x'.repeat(40)}-a1b2c3`);
  });

  it('a title with no ASCII letters or digits keeps only the suffix', () => {
    expect(handOutBranchName('로그인 고치기', 'a1b2c3')).toBe('hand-out-a1b2c3');
  });
});

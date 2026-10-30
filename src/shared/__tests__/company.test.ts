import { describe, expect, it } from 'vitest';
import type { Message, WmuxTaskMetadata } from '../types';
import {
  BRIEF_FIELDS,
  COMPANY_BRIEF_KIND,
  decideCompanySend,
  companyCancelRefusal,
  companyOfWorkspace,
  isCompanyTask,
  missingBriefFields,
  parseWorkspaceCompany,
  type CompanyWorkspaceView,
} from '../company';

const BRIEF = {
  kind: COMPANY_BRIEF_KIND,
  v: 1,
  goal: 'Ship the parser',
  scope: 'src/parser only',
  acceptance: 'tests pass',
  verify: 'npm test',
  report: 'reply with the diff summary',
};

// Company "Eng": home ws-home (coordinator pty-coord, member pty-m1), a
// member workspace ws-member (pty-m2). Company "Ops": home ws-ops with its
// coordinator pty-ops. ws-plain is in no company.
const WORKSPACES: CompanyWorkspaceView[] = [
  { id: 'ws-home', company: { v: 1, kind: 'home', id: 'd-eng', name: 'Eng', coordinatorPtyId: 'pty-coord' }, ptyIds: ['pty-coord', 'pty-m1'] },
  { id: 'ws-member', company: { v: 1, kind: 'member', id: 'd-eng' }, ptyIds: ['pty-m2'] },
  { id: 'ws-ops', company: { v: 1, kind: 'home', id: 'd-ops', name: 'Ops', coordinatorPtyId: 'pty-ops' }, ptyIds: ['pty-ops', 'pty-ops2'] },
  { id: 'ws-plain', ptyIds: ['pty-plain'] },
];

function send(over: Partial<Parameters<typeof decideCompanySend>[0]>) {
  return decideCompanySend({
    workspaces: WORKSPACES,
    targetWorkspaceId: 'ws-home',
    targetPtyId: 'pty-m1',
    senderPtyId: 'pty-coord',
    operator: false,
    data: BRIEF,
    ...over,
  });
}

function task(history: Message[], from: WmuxTaskMetadata['from']) {
  return { history, metadata: { from } };
}

const briefMessage: Message = {
  kind: 'message',
  messageId: 'msg-1',
  role: 'user',
  parts: [{ kind: 'text', text: 'do it' }, { kind: 'data', data: BRIEF }],
};
const plainMessage: Message = { kind: 'message', messageId: 'msg-2', role: 'user', parts: [{ kind: 'text', text: 'hi' }] };

describe('parseWorkspaceCompany', () => {
  it('keeps a home and a member record and drops anything else', () => {
    expect(parseWorkspaceCompany({ v: 1, kind: 'home', id: 'd', name: 'Eng', coordinatorPtyId: 'pty-1' }))
      .toEqual({ v: 1, kind: 'home', id: 'd', name: 'Eng', coordinatorPtyId: 'pty-1' });
    expect(parseWorkspaceCompany({ v: 1, kind: 'member', id: 'd', extra: 1 })).toEqual({ v: 1, kind: 'member', id: 'd' });
    expect(parseWorkspaceCompany({ v: 1, kind: 'home', id: 'd', name: 'Eng' })?.kind).toBe('home');
    expect(parseWorkspaceCompany({ v: 2, kind: 'home', id: 'd', name: 'Eng' })).toBeUndefined();
    expect(parseWorkspaceCompany({ v: 1, kind: 'home', id: 'd', name: '' })).toBeUndefined();
    expect(parseWorkspaceCompany('ceo')).toBeUndefined();
  });
});

describe('missingBriefFields / isCompanyTask', () => {
  it('names every empty or absent field, all of them for a non-brief', () => {
    expect(missingBriefFields(BRIEF)).toEqual([]);
    expect(missingBriefFields({ ...BRIEF, scope: '  ', verify: undefined })).toEqual(['scope', 'verify']);
    expect(missingBriefFields({ goal: 'x' })).toEqual([...BRIEF_FIELDS]);
    expect(missingBriefFields(undefined)).toEqual([...BRIEF_FIELDS]);
  });

  it('a company task is one whose first message carries a brief', () => {
    expect(isCompanyTask([briefMessage])).toBe(true);
    expect(isCompanyTask([plainMessage, briefMessage])).toBe(false);
    expect(isCompanyTask([])).toBe(false);
  });
});

describe('companyOfWorkspace', () => {
  it('places a member workspace in its home company', () => {
    expect(companyOfWorkspace(WORKSPACES, 'ws-member')).toEqual({
      id: 'd-eng', name: 'Eng', homeWorkspaceId: 'ws-home', coordinatorPtyId: 'pty-coord',
    });
    expect(companyOfWorkspace(WORKSPACES, 'ws-plain')).toBeNull();
  });

  it('a coordinator pty that left the home workspace is a vacant seat', () => {
    const moved = WORKSPACES.map((w) => (w.id === 'ws-home' ? { ...w, ptyIds: ['pty-m1'] } : w));
    expect(companyOfWorkspace(moved, 'ws-home')?.coordinatorPtyId).toBeNull();
  });

  it('a member whose home is gone belongs to no company', () => {
    const noHome = WORKSPACES.filter((w) => w.id !== 'ws-home');
    expect(companyOfWorkspace(noHome, 'ws-member')).toBeNull();
  });
});

describe('decideCompanySend', () => {
  it('leaves a target outside every company alone', () => {
    expect(send({ targetWorkspaceId: 'ws-plain', targetPtyId: 'pty-plain', senderPtyId: '', data: undefined }))
      .toEqual({ kind: 'allow', companyTask: false });
  });

  it('lets the coordinator brief a member, and a member brief another', () => {
    expect(send({})).toEqual({ kind: 'allow', companyTask: true });
    expect(send({ targetWorkspaceId: 'ws-member', targetPtyId: 'pty-m2', senderPtyId: 'pty-m1' }))
      .toEqual({ kind: 'allow', companyTask: true });
  });

  it('lets work from outside in only through the coordinator', () => {
    expect(send({ targetPtyId: 'pty-coord', senderPtyId: 'pty-plain' })).toEqual({ kind: 'allow', companyTask: true });
    const toMember = send({ senderPtyId: 'pty-plain' });
    expect(toMember).toMatchObject({ kind: 'refuse' });
    expect(toMember.kind === 'refuse' && toMember.error).toContain('through its coordinator');
    // Another company's coordinator goes through this one's coordinator too.
    expect(send({ senderPtyId: 'pty-ops' })).toMatchObject({ kind: 'refuse' });
    expect(send({ targetPtyId: 'pty-coord', senderPtyId: 'pty-ops' })).toEqual({ kind: 'allow', companyTask: true });
  });

  it('says when the company has no coordinator to go through', () => {
    const vacant = WORKSPACES.map((w) => (w.id === 'ws-home'
      ? { ...w, company: { v: 1 as const, kind: 'home' as const, id: 'd-eng', name: 'Eng', coordinatorPtyId: null } }
      : w));
    const res = send({ workspaces: vacant, senderPtyId: 'pty-plain' });
    expect(res.kind === 'refuse' && res.error).toContain('has none right now');
  });

  it('refuses without a brief, naming the missing fields', () => {
    const res = send({ data: { ...BRIEF, acceptance: '' } });
    expect(res).toMatchObject({ kind: 'refuse' });
    expect(res.kind === 'refuse' && res.error).toContain('missing: acceptance');
  });

  it('refuses a caller wmux cannot tie to a pane, or an unpinned receiver', () => {
    expect(send({ senderPtyId: '' })).toMatchObject({ kind: 'refuse' });
    // A pty no workspace owns reads as no caller at all.
    expect(send({ senderPtyId: 'pty-forged' })).toMatchObject({ kind: 'refuse' });
    const unpinned = send({ targetPtyId: null });
    expect(unpinned.kind === 'refuse' && unpinned.error).toContain('pane_id');
  });

  it('exempts the human lane, which needs neither a pane nor a brief', () => {
    expect(send({ operator: true, senderPtyId: '', targetPtyId: null, data: undefined }))
      .toEqual({ kind: 'allow', companyTask: false });
  });
});

describe('companyCancelRefusal', () => {
  const fromCoordinator = { workspaceId: 'ws-home', name: 'Eng', paneId: 'pane-coord' };

  it('lets only the creating pane cancel a company task', () => {
    const t = task([briefMessage], fromCoordinator);
    expect(companyCancelRefusal(t, { workspaceId: 'ws-home', paneId: 'pane-coord', trusted: false })).toBeNull();
    // A sibling pane of the same workspace, or no pane at all, is refused.
    expect(companyCancelRefusal(t, { workspaceId: 'ws-home', paneId: 'pane-m1', trusted: false })).toContain('only the pane');
    expect(companyCancelRefusal(t, { workspaceId: 'ws-home', paneId: undefined, trusted: false })).toContain('only the pane');
  });

  it('leaves ordinary tasks and the trusted lanes alone', () => {
    expect(companyCancelRefusal(task([plainMessage], fromCoordinator), { workspaceId: 'ws-home', paneId: undefined, trusted: false })).toBeNull();
    expect(companyCancelRefusal(task([briefMessage], fromCoordinator), { workspaceId: 'ws-x', paneId: undefined, trusted: true })).toBeNull();
  });
});

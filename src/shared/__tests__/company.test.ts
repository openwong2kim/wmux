import { describe, expect, it } from 'vitest';
import { finalizeSpawnPrompt } from '../a2aSpawnPrompt';
import type { Message, WmuxTaskMetadata } from '../types';
import {
  BRIEF_FIELDS,
  COMPANY_BRIEF_KIND,
  decideCompanySend,
  REMOTE_SEAT_FINISH_LINE,
  companyBriefOf,
  companyCancelRefusal,
  companyDoneRefusal,
  companySeatOf,
  companyOfWorkspace,
  isCompanyTask,
  missingBriefFields,
  parseWorkspaceCompany,
  remoteSeatIntro,
  renderRemoteBrief,
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

// Company "Eng" is ws-eng: coordinator pane-coord and staff pane-m1, pane-m2.
// Company "Ops" is ws-ops with its coordinator pane-ops. ws-plain is no company.
const WORKSPACES: CompanyWorkspaceView[] = [
  {
    id: 'ws-eng',
    name: 'Eng',
    company: { v: 1, id: 'co-eng', coordinatorPaneId: 'pane-coord' },
    paneIds: ['pane-coord', 'pane-m1', 'pane-m2'],
    ptyIds: ['pty-coord', 'pty-m1', 'pty-m2'],
  },
  { id: 'ws-ops', name: 'Ops', company: { v: 1, id: 'co-ops', coordinatorPaneId: 'pane-ops' }, paneIds: ['pane-ops'], ptyIds: ['pty-ops'] },
  { id: 'ws-plain', name: 'plain', paneIds: ['pane-plain'], ptyIds: ['pty-plain'] },
];

function send(over: Partial<Parameters<typeof decideCompanySend>[0]>) {
  return decideCompanySend({
    workspaces: WORKSPACES,
    targetWorkspaceId: 'ws-eng',
    targetPaneId: 'pane-m1',
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
  it('keeps a company record and drops anything else', () => {
    expect(parseWorkspaceCompany({ v: 1, id: 'co', coordinatorPaneId: 'pane-1', extra: 1 }))
      .toEqual({ v: 1, id: 'co', coordinatorPaneId: 'pane-1' });
    expect(parseWorkspaceCompany({ v: 1, id: 'co', coordinatorPaneId: null })).toEqual({ v: 1, id: 'co', coordinatorPaneId: null });
    // A record that names no seat at all is not a company.
    expect(parseWorkspaceCompany({ v: 1, kind: 'member', id: 'co' })).toBeUndefined();
    expect(parseWorkspaceCompany({ v: 2, id: 'co', coordinatorPaneId: null })).toBeUndefined();
    expect(parseWorkspaceCompany({ v: 1, id: '', coordinatorPaneId: null })).toBeUndefined();
    expect(parseWorkspaceCompany('ceo')).toBeUndefined();
  });

  it('keeps a written mission and drops an empty or non-text one', () => {
    expect(parseWorkspaceCompany({ v: 1, id: 'co', coordinatorPaneId: 'pane-1', mission: 'Ship 4.14 green' }))
      .toEqual({ v: 1, id: 'co', coordinatorPaneId: 'pane-1', mission: 'Ship 4.14 green' });
    expect(parseWorkspaceCompany({ v: 1, id: 'co', coordinatorPaneId: 'pane-1', mission: '' })).not.toHaveProperty('mission');
    expect(parseWorkspaceCompany({ v: 1, id: 'co', coordinatorPaneId: 'pane-1', mission: 42 })).not.toHaveProperty('mission');
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
  it('names the company after its workspace', () => {
    expect(companyOfWorkspace(WORKSPACES, 'ws-eng')).toEqual({
      id: 'co-eng', name: 'Eng', workspaceId: 'ws-eng', coordinatorPaneId: 'pane-coord',
    });
    expect(companyOfWorkspace(WORKSPACES, 'ws-plain')).toBeNull();
  });

  it('keeps the seat when the coordinator pane gets a new pty, and vacates it when the pane is gone', () => {
    const restarted = WORKSPACES.map((w) => (w.id === 'ws-eng' ? { ...w, ptyIds: ['pty-coord-2', 'pty-m1', 'pty-m2'] } : w));
    expect(companyOfWorkspace(restarted, 'ws-eng')?.coordinatorPaneId).toBe('pane-coord');
    const closed = WORKSPACES.map((w) => (w.id === 'ws-eng' ? { ...w, paneIds: ['pane-m1', 'pane-m2'] } : w));
    expect(companyOfWorkspace(closed, 'ws-eng')?.coordinatorPaneId).toBeNull();
  });
});

describe('decideCompanySend', () => {
  it('leaves a target outside every company alone', () => {
    expect(send({ targetWorkspaceId: 'ws-plain', targetPaneId: 'pane-plain', senderPtyId: '', data: undefined }))
      .toEqual({ kind: 'allow', companyTask: false });
  });

  it('lets the coordinator brief a staff pane, and one staff pane brief another', () => {
    expect(send({})).toEqual({ kind: 'allow', companyTask: true });
    expect(send({ targetPaneId: 'pane-m2', senderPtyId: 'pty-m1' })).toEqual({ kind: 'allow', companyTask: true });
  });

  it('takes a request to the coordinator from anyone, with or without a brief', () => {
    expect(send({ targetPaneId: 'pane-coord', senderPtyId: 'pty-plain', data: { goal: 'Add Apple Pay' } }))
      .toEqual({ kind: 'allow', companyTask: false });
    expect(send({ targetPaneId: 'pane-coord', senderPtyId: 'pty-ops' })).toEqual({ kind: 'allow', companyTask: true });
  });

  it('lets work from outside reach a staff pane only through the coordinator', () => {
    const fromOutside = send({ senderPtyId: 'pty-plain' });
    expect(fromOutside).toMatchObject({ kind: 'refuse' });
    expect(fromOutside.kind === 'refuse' && fromOutside.error).toContain('through its coordinator');
    // Another company's coordinator goes through this one's coordinator too.
    expect(send({ senderPtyId: 'pty-ops' })).toMatchObject({ kind: 'refuse' });
  });

  it('says when the company has no coordinator to go through', () => {
    const vacant = WORKSPACES.map((w) => (w.id === 'ws-eng'
      ? { ...w, company: { v: 1 as const, id: 'co-eng', coordinatorPaneId: null } }
      : w));
    const res = send({ workspaces: vacant, senderPtyId: 'pty-plain' });
    expect(res.kind === 'refuse' && res.error).toContain('has none right now');
  });

  it('refuses a staff pane without a brief, naming the missing fields', () => {
    const res = send({ data: { ...BRIEF, acceptance: '' } });
    expect(res).toMatchObject({ kind: 'refuse' });
    expect(res.kind === 'refuse' && res.error).toContain('missing: acceptance');
  });

  it('refuses a caller wmux cannot tie to a pane, or an unpinned receiver', () => {
    expect(send({ senderPtyId: '' })).toMatchObject({ kind: 'refuse' });
    expect(send({ targetPaneId: 'pane-coord', senderPtyId: '' })).toMatchObject({ kind: 'refuse' });
    // A pty no workspace owns reads as no caller at all.
    expect(send({ senderPtyId: 'pty-forged' })).toMatchObject({ kind: 'refuse' });
    const unpinned = send({ targetPaneId: null });
    expect(unpinned.kind === 'refuse' && unpinned.error).toContain('pane_id');
  });

  it('exempts the human lane, which needs neither a pane nor a brief', () => {
    expect(send({ operator: true, senderPtyId: '', targetPaneId: null, data: undefined }))
      .toEqual({ kind: 'allow', companyTask: false });
  });

  it('refuses a background worker for any company pane, except from the human lane', () => {
    const staff = send({ execute: true });
    expect(staff).toMatchObject({ kind: 'refuse' });
    expect(staff.kind === 'refuse' && staff.error).toContain('without execute');
    expect(send({ execute: true, targetPaneId: 'pane-coord', senderPtyId: 'pty-plain', data: undefined }))
      .toMatchObject({ kind: 'refuse' });
    expect(send({ execute: true, operator: true })).toEqual({ kind: 'allow', companyTask: true });
    expect(send({ execute: true, targetWorkspaceId: 'ws-plain', targetPaneId: 'pane-plain', senderPtyId: '', data: undefined }))
      .toEqual({ kind: 'allow', companyTask: false });
  });
});

describe('companyCancelRefusal', () => {
  const fromCoordinator = { workspaceId: 'ws-eng', name: 'Eng', paneId: 'pane-coord' };

  it('lets only the creating pane cancel a company task', () => {
    const t = task([briefMessage], fromCoordinator);
    expect(companyCancelRefusal(t, { workspaceId: 'ws-eng', paneId: 'pane-coord', trusted: false })).toBeNull();
    // A sibling pane of the same workspace, or no pane at all, is refused.
    expect(companyCancelRefusal(t, { workspaceId: 'ws-eng', paneId: 'pane-m1', trusted: false })).toContain('only the pane');
    expect(companyCancelRefusal(t, { workspaceId: 'ws-eng', paneId: undefined, trusted: false })).toContain('only the pane');
  });

  it('leaves ordinary tasks and the trusted lanes alone', () => {
    expect(companyCancelRefusal(task([plainMessage], fromCoordinator), { workspaceId: 'ws-eng', paneId: undefined, trusted: false })).toBeNull();
    expect(companyCancelRefusal(task([briefMessage], fromCoordinator), { workspaceId: 'ws-x', paneId: undefined, trusted: true })).toBeNull();
  });
});

describe('companyDoneRefusal', () => {
  const t = { history: [briefMessage] };

  it('refuses the staff seat that did the work and tells it to report instead', () => {
    const refusal = companyDoneRefusal(t, { trusted: false, seat: 'staff' });
    expect(refusal).toContain('coordinator (CEO) pane or the human');
    expect(refusal).toContain('input-required');
    expect(refusal).toContain('PR URL');
  });

  it('lets the coordinator or the human mark it done', () => {
    expect(companyDoneRefusal(t, { trusted: false, seat: 'coordinator' })).toBeNull();
    expect(companyDoneRefusal(t, { trusted: true, seat: 'staff' })).toBeNull();
  });

  it('lets a receiver in no company finish a briefed task: it has no CEO to report to', () => {
    expect(companyDoneRefusal(t, { trusted: false, seat: undefined })).toBeNull();
  });

  it('leaves ordinary tasks alone', () => {
    expect(companyDoneRefusal({ history: [plainMessage] }, { trusted: false, seat: 'staff' })).toBeNull();
  });
});

describe('companySeatOf', () => {
  const company = { v: 1 as const, id: 'co', coordinatorPaneId: 'pane-ceo' };

  it('reads the coordinator and the staff, and nothing outside a company', () => {
    expect(companySeatOf(company, 'pane-ceo')).toBe('coordinator');
    expect(companySeatOf(company, 'pane-dev')).toBe('staff');
    expect(companySeatOf({ ...company, coordinatorPaneId: null }, 'pane-ceo')).toBe('staff');
    expect(companySeatOf(undefined, 'pane-dev')).toBeUndefined();
    expect(companySeatOf(company, undefined)).toBeUndefined();
  });
});

describe('companyBriefOf', () => {
  it('keeps only the brief fields of a complete version-1 brief', () => {
    const brief = companyBriefOf({ ...BRIEF, blockedBy: ['task-1'], deliveryKey: 'k', note: 'x', paneId: 'pane-x' });
    expect(brief).toEqual({ ...BRIEF, blockedBy: ['task-1'] });
  });

  it('drops a blockedBy that is not a list of strings', () => {
    expect(companyBriefOf({ ...BRIEF, blockedBy: ['task-1', 2] })).toEqual(BRIEF);
    expect(companyBriefOf({ ...BRIEF, blockedBy: 'task-1' })).toEqual(BRIEF);
  });

  it('is null for a partial brief, another version, or no brief at all', () => {
    expect(companyBriefOf({ ...BRIEF, verify: ' ' })).toBeNull();
    expect(companyBriefOf({ ...BRIEF, v: 2 })).toBeNull();
    expect(companyBriefOf(undefined)).toBeNull();
    expect(companyBriefOf([BRIEF])).toBeNull();
  });
});

describe('renderRemoteBrief', () => {
  it('writes the message, the five fields under their names, then how a seat on another PC finishes', () => {
    const text = renderRemoteBrief('Take the parser.', companyBriefOf(BRIEF)!);
    expect(text).toBe([
      'Take the parser.',
      'Goal:\nShip the parser',
      'Scope:\nsrc/parser only',
      'Acceptance:\ntests pass',
      'Verify:\nnpm test',
      'Report:\nreply with the diff summary',
      REMOTE_SEAT_FINISH_LINE,
    ].join('\n\n'));
    expect(REMOTE_SEAT_FINISH_LINE).toBe('When it is done, finish this task as completed with evidence: the PR URL, its head commit, '
      + 'what you ran and who ran the live check. The CEO checks it and marks it done on its PC.');
  });

  it('keeps a multi-line value whole under its name', () => {
    const text = renderRemoteBrief('Go.', companyBriefOf({ ...BRIEF, acceptance: '  - parser tests pass\n- lint is clean\n' })!);
    expect(text).toContain('Acceptance:\n- parser tests pass\n- lint is clean\n\nVerify:\nnpm test');
  });

  it('writes nothing else of the data', () => {
    const text = renderRemoteBrief('Go.', companyBriefOf({ ...BRIEF, blockedBy: ['task-blocker-1'], deliveryKey: 'dk-1', extra: 'other-note' })!);
    for (const s of ['task-blocker-1', 'dk-1', 'other-note', COMPANY_BRIEF_KIND, 'blockedBy']) expect(text).not.toContain(s);
  });
});

describe('remoteSeatIntro', () => {
  const full = {
    name: 'linux-build',
    company: 'wmux',
    mission: 'Keep every PC busy and ship company mode',
    owns: 'Linux-only fixes and the Linux check before merge.',
    ceo: 'pm',
    standingOrders: 'Every PR gets a live check before merge.',
  };

  it('says who the seat is, what it owns, who its CEO is, how briefs come and finish, and the standing orders', () => {
    expect(remoteSeatIntro(full).split('\n')).toEqual([
      'You are linux-build, a seat of the company "wmux" (mission: Keep every PC busy and ship company mode).',
      'You own: Linux-only fixes and the Linux check before merge.',
      'Your CEO is pm on the PC that started you; its briefs come here as tasks with Goal, Scope, Acceptance, Verify and Report.',
      `Each brief ends with how to finish it: ${REMOTE_SEAT_FINISH_LINE}`,
      'Standing orders: Every PR gets a live check before merge.',
      'Wait for a brief.',
    ]);
  });

  it('leaves out what it owns, the mission and the standing orders when there are none', () => {
    const text = remoteSeatIntro({ name: 'win-dev', company: 'wmux', owns: '  ', ceo: 'pm', standingOrders: '' });
    expect(text.split('\n')).toEqual([
      'You are win-dev, a seat of the company "wmux".',
      'Your CEO is pm on the PC that started you; its briefs come here as tasks with Goal, Scope, Acceptance, Verify and Report.',
      `Each brief ends with how to finish it: ${REMOTE_SEAT_FINISH_LINE}`,
      'Wait for a brief.',
    ]);
    expect(text).not.toContain('You own');
    expect(text).not.toContain('Standing orders');
  });

  it('names no PC, so the send masks nothing in it', () => {
    expect(finalizeSpawnPrompt(remoteSeatIntro({ ...full, name: 'wong2kimui-macbookair-local-dev' })).masked).toBe(0);
  });

  it('carries no brief: no data kind and no brief field written out', () => {
    const text = remoteSeatIntro(full);
    expect(text).not.toContain(COMPANY_BRIEF_KIND);
    for (const heading of ['Goal:', 'Scope:', 'Acceptance:', 'Verify:', 'Report:']) expect(text).not.toContain(heading);
  });
});

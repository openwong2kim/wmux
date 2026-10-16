// What the owner reads of a card or a thread: names, never internal ids,
// role tags or machine codes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomCard } from '../../../../shared/room';
import { setLocale, t as i18nT } from '../../../i18n';
import { actorLabel, cardResumeTaskId, formatCardTime, formatNoticeTime, noticeText, ownerCardText, requestTitles, routineCardBody, threadLabel, withoutInternalIds, withoutReasonCodes, withoutRoleTags } from '../roomFormat';

const t = (key: string) => key;
const system = { kind: 'system' as const };
const bot = { kind: 'bot' as const, workspaceId: 'w1', botId: 'bot-0000000a' };
const base = (over: Partial<RoomCard>): Pick<RoomCard, 'kind' | 'title' | 'body' | 'actor'> => ({ kind: 'fact', title: '', actor: system, ...over });

describe('threadLabel', () => {
  it('keeps a PR or issue reference, names a task by its title, else by its kind word', () => {
    expect(threadLabel('general', t)).toBe('room.thread.general');
    expect(threadLabel('pr:github.com/acme/app#1', t)).toBe('acme/app#1');
    expect(threadLabel('issue:github.com/acme/app#7', t)).toBe('acme/app#7');
    expect(threadLabel('task:wtask-abc', t, (id) => (id === 'wtask-abc' ? 'README title' : null))).toBe('README title');
    expect(threadLabel('task:wtask-other', t, () => null)).toBe('room.thread.task');
    expect(threadLabel('task:wtask-blank', t, () => '  ')).toBe('room.thread.task');
    expect(threadLabel('handoff:h-mv6si', t)).toBe('room.thread.handoff');
    expect(threadLabel('plan:p-1', t)).toBe('room.thread.plan');
    expect(threadLabel('report:r-1', t)).toBe('room.thread.report');
  });

  it('names a request thread by the owner\'s words that opened it, else "Request"', () => {
    const card = (over: Partial<RoomCard>): RoomCard => ({ version: 1, id: 'x', seq: 1, workspaceId: 'w1', threadId: 'general', kind: 'fact', at: 1, actor: system, title: '', ...over });
    const cards = [
      card({ id: 'c-owner', kind: 'human', actor: { kind: 'human' }, title: '  Add a --version flag to calc.py ' }),
      card({ id: 'c-hop', threadId: 'handoff:h-1', title: 'dispatch → Research: Ship it', refs: { handoffId: 'h-1', requestCardId: 'c-owner' } }),
      // A link to a card that is not the owner's names nothing.
      card({ id: 'c-bot', actor: bot, title: 'I did it' }),
      card({ id: 'c-hop2', threadId: 'handoff:h-2', title: 'dispatch → Research: Other', refs: { handoffId: 'h-2', requestCardId: 'c-bot' } }),
      // A bot's card cannot name a thread, nor can another room's request or another thread's hop.
      card({ id: 'c-other', workspaceId: 'w2', kind: 'human', actor: { kind: 'human' }, title: 'Room two words' }),
      card({ id: 'c-forged', threadId: 'handoff:h-3', actor: bot, title: 'x', refs: { handoffId: 'h-3', requestCardId: 'c-owner' } }),
      card({ id: 'c-far', threadId: 'handoff:h-4', title: 'x', refs: { handoffId: 'h-4', requestCardId: 'c-other' } }),
      card({ id: 'c-moved', threadId: 'handoff:h-5', title: 'x', refs: { handoffId: 'h-9', requestCardId: 'c-owner' } }),
    ];
    const titles = requestTitles(cards);
    expect([...titles]).toEqual([['handoff:h-1', 'Add a --version flag to calc.py']]);
    const of = (id: string) => titles.get(id as never) ?? null;
    expect(threadLabel('handoff:h-1', t, undefined, of)).toBe('Add a --version flag to calc.py');
    expect(threadLabel('handoff:h-2', t, undefined, of)).toBe('room.thread.handoff');
  });
});

describe('owner text', () => {
  it('a routine card shows its schedule, not the instructions the bot gave itself', () => {
    expect(routineCardBody('every 30 min\n\nissue_read로 열린 이슈를 읽고 bot-556702fb에 넘겨라.')).toBe('every 30 min');
    expect(routineCardBody(undefined)).toBe('');
    expect(ownerCardText(base({ kind: 'routine', actor: bot, title: 'Routine created: 새 이슈 확인', body: 'every 30 min\n\nprompt' }), []))
      .toEqual({ title: 'Routine created: 새 이슈 확인', body: 'every 30 min' });
  });

  it('a refusal keeps its plain sentences and drops the codes after them; a line that is only a code stays', () => {
    const body = '- The repository has no required checks `required-checks-green:no-required-checks`\n- GitHub listed no changed files `not-release-pr:no-files` `gate-definition-changed:no-files`\n- `odd-code`';
    expect(withoutReasonCodes(body)).toBe('- The repository has no required checks\n- GitHub listed no changed files\n- `odd-code`');
    expect(ownerCardText(base({ kind: 'refusal', title: 'Merge refused for #1', body }), []).body).not.toContain('no-required-checks');
    // Inline code inside a sentence, or a plain word, is not a reason code.
    expect(withoutReasonCodes('Run `npm test` again')).toBe('Run `npm test` again');
    expect(withoutReasonCodes('The protected branch `main` cannot be updated with `git`.')).toBe('The protected branch `main` cannot be updated with `git`.');
    expect(withoutReasonCodes('Push it with `git`')).toBe('Push it with `git`');
    expect(withoutReasonCodes('Lane auto-merge is off `lane-paused`')).toBe('Lane auto-merge is off');
  });

  it('drops a role tag after a bot\'s name in what main wrote, never in a bot\'s own words', () => {
    expect(withoutRoleTags('Answered → Wmux Dev (lead): Push?', ['Wmux Dev'])).toBe('Answered → Wmux Dev: Push?');
    expect(withoutRoleTags('Ask Wmux Dev (maybe later)', ['Wmux Dev'])).toBe('Ask Wmux Dev (maybe later)');
    expect(withoutRoleTags('Someone (lead) said', ['Wmux Dev'])).toBe('Someone (lead) said');
    expect(withoutRoleTags('A.b (verifier)', ['A.b'])).toBe('A.b');
    expect(ownerCardText(base({ title: 'Answered → Wmux Dev (lead): Q', body: 'to Wmux Dev (lead)' }), ['Wmux Dev'])).toEqual({ title: 'Answered → Wmux Dev: Q', body: 'to Wmux Dev' });
    expect(ownerCardText(base({ kind: 'status', actor: bot, title: 'I am Wmux Dev (lead)' }), ['Wmux Dev']).title).toBe('I am Wmux Dev (lead)');
  });

  it('a bot\'s words show the ids it cites as what they stand for; code blocks and unknown ids stay', () => {
    const labels = {
      taskTitle: (id: string) => (id === 'wtask-mv6yznk5-tv3qhcng' ? 'Verify PR #1' : null),
      approval: (id: string) => (id === 'apr-NQMvlIDZu05W' ? 'PR #2 approval' : null),
    };
    expect(withoutInternalIds('검증 작업 `wtask-mv6yznk5-tv3qhcng`: lint 통과', labels)).toBe('검증 작업 Verify PR #1: lint 통과');
    expect(withoutInternalIds('머지 승인 카드(apr-NQMvlIDZu05W)를 올렸습니다', labels)).toBe('머지 승인 카드(PR #2 approval)를 올렸습니다');
    expect(withoutInternalIds('thread task:wtask-mv6yznk5-tv3qhcng and pr:github.com/acme/app#2, issue:acme/app#7', labels)).toBe('thread Verify PR #1 and PR #2, issue #7');
    // An id nothing resolves, and a longer token that only contains one, stay.
    expect(withoutInternalIds('task wtask-abc-unknown1 and apr-zzzzzzzzzz', labels)).toBe('task wtask-abc-unknown1 and apr-zzzzzzzzzz');
    expect(withoutInternalIds('branch wtask-mv6yznk5-tv3qhcng-x', labels)).toBe('branch wtask-mv6yznk5-tv3qhcng-x');
    // Inline code with more in it, and fenced blocks, are left as written.
    expect(withoutInternalIds('run `git log wtask-mv6yznk5-tv3qhcng`', labels)).toBe('run `git log wtask-mv6yznk5-tv3qhcng`');
    const fenced = '```\nwtask-mv6yznk5-tv3qhcng apr-NQMvlIDZu05W\n```\nsee wtask-mv6yznk5-tv3qhcng';
    expect(withoutInternalIds(fenced, labels)).toBe('```\nwtask-mv6yznk5-tv3qhcng apr-NQMvlIDZu05W\n```\nsee Verify PR #1');
    // A fence closes only at a line of its own: backticks inside a code line
    // do not end it, and an unclosed fence runs to the end.
    const inner = '```\necho "```" wtask-mv6yznk5-tv3qhcng\n```\nok wtask-mv6yznk5-tv3qhcng\n  ```sh\napr-NQMvlIDZu05W';
    expect(withoutInternalIds(inner, labels)).toBe('```\necho "```" wtask-mv6yznk5-tv3qhcng\n```\nok Verify PR #1\n  ```sh\napr-NQMvlIDZu05W');
    // Only a bot's own words, and only with labels.
    const card = base({ kind: 'status', actor: bot, title: 'apr-NQMvlIDZu05W', body: 'task `wtask-mv6yznk5-tv3qhcng`' });
    expect(ownerCardText(card, [], labels)).toEqual({ title: 'PR #2 approval', body: 'task Verify PR #1' });
    expect(ownerCardText(card, [])).toEqual({ title: 'apr-NQMvlIDZu05W', body: 'task `wtask-mv6yznk5-tv3qhcng`' });
    expect(ownerCardText(base({ title: 'apr-NQMvlIDZu05W' }), [], labels).title).toBe('apr-NQMvlIDZu05W');
  });
});

describe('factory system cards in the reader\'s language (RoomCard.notice)', () => {
  const card = (over: Partial<RoomCard>): Pick<RoomCard, 'kind' | 'title' | 'body' | 'actor' | 'notice' | 'refs'> => ({ kind: 'fact', title: 'English title', body: 'English body', actor: system, ...over });
  afterEach(() => setLocale('en'));

  it('a task wmux moved to input_required says why in the reader\'s language; a worker\'s own words stay (#2231)', () => {
    setLocale('ko');
    const trust = noticeText(card({ body: "worker is waiting on Claude Code's workspace trust dialog; it needs a keypress in the pane", notice: { code: 'task.inputRequired', args: { title: 'add', why: 'trustDialog' } } }), i18nT);
    expect(trust?.title).toBe('작업 입력 필요: add');
    expect(trust?.body).toContain('신뢰하는지');
    expect(noticeText(card({ notice: { code: 'task.inputRequired', args: { title: 'add', why: 'launchFailed' } } }), i18nT)?.body).toContain('셸 프롬프트');
    // The worker's own reason (no why), or a why this build does not know: as written.
    expect(noticeText(card({ body: 'need the API key', notice: { code: 'task.inputRequired', args: { title: 'add' } } }), i18nT)?.body).toBe('need the API key');
    expect(noticeText(card({ body: 'x', notice: { code: 'task.inputRequired', args: { title: 'add', why: 'later' } } }), i18nT)?.body).toBe('x');
  });

  it('words a known code in Korean, its values worded too; evidence bodies stay as written', () => {
    setLocale('ko');
    expect(noticeText(card({ notice: { code: 'worker.pausedResumable' } }), i18nT)?.title).toBe('워커 일시 중지됨 (이어서 가능)');
    const done = noticeText(card({ notice: { code: 'worker.done', args: { status: 'cancelled' } } }), i18nT);
    expect(done?.body).toContain('작업 취소됨:');
    expect(done?.body).toContain('창은 닫혀요.');
    expect(noticeText(card({ notice: { code: 'gate.noBase', args: { detail: 'origin/main has no npm test script' } } }), i18nT)?.body)
      .toMatch(/^origin\/main has no npm test script\.\n\n지금 상태로는/);
    // The gate's evidence (its command, an error) is not reworded.
    expect(noticeText(card({ body: '`npm test` at abc1234', notice: { code: 'gate.failed', args: { exit: 2 } } }), i18nT))
      .toEqual({ title: '게이트 실패 (종료 코드 2): 작업은 열린 채로 둠', body: '`npm test` at abc1234' });
    expect(ownerCardText(card({ notice: { code: 'research.completed' } }), [], undefined, i18nT).title).toBe('조사 보고됨: 작업 완료');
  });

  it('keeps the English for no code, an unknown code or value, and a card that is not the system\'s', () => {
    setLocale('ko');
    expect(noticeText(card({}), i18nT)).toBeNull();
    expect(noticeText(card({ notice: { code: 'worker.someday' } }), i18nT)).toBeNull();
    expect(noticeText(card({ notice: { code: 'worker.done', args: { status: 'exploded' } } }), i18nT)).toBeNull();
    expect(noticeText(card({ actor: bot, notice: { code: 'worker.paused' } }), i18nT)).toBeNull();
    expect(ownerCardText(card({ notice: { code: 'worker.someday' } }), [], undefined, i18nT)).toEqual({ title: 'English title', body: 'English body' });
  });

  it('a budget card says which limit and when the bot picks up again, in the reader\'s language', () => {
    const now = new Date(2026, 9, 16, 1, 38).getTime();
    const until = new Date(2026, 9, 16, 2, 37).getTime();
    const hour = card({ kind: 'budget', notice: { code: 'budget.exhausted', args: { bot: 'Reviewer', limit: 'turns_hour', until } } });
    const en = noticeText(hour, i18nT, now);
    expect(en?.title).toBe('Reviewer is out of turns for this hour');
    expect(en?.body).toContain(`It picks up again at ${formatNoticeTime(until, now)}`);
    expect(en?.title).not.toContain('turns_hour');
    // No time: what lifts it; a worker limit: when a worker ends.
    expect(noticeText(card({ notice: { code: 'budget.exhausted', args: { bot: 'Reviewer', limit: 'turns_day' } } }), i18nT, now)?.body).toMatch(/raise its limit or resume it/);
    expect(noticeText(card({ notice: { code: 'budget.exhausted', args: { bot: 'Reviewer', limit: 'concurrent_workers' } } }), i18nT, now)?.body).toMatch(/one of the running ones ends/);
    setLocale('ko');
    const ko = noticeText(hour, i18nT, now);
    expect(ko?.title).toBe('Reviewer: 이번 시간의 턴을 모두 썼습니다');
    expect(ko?.body).toContain(formatNoticeTime(until, now));
    expect(noticeText(card({ notice: { code: 'budget.held', args: { bot: 'Reviewer', until } } }), i18nT, now)?.title).toBe('대기 중: Reviewer의 턴이 소진됐습니다');
    // A usage-limit park: the title is worded, the body is the provider's own text.
    const limit = noticeText(card({ body: "You've hit your session limit", notice: { code: 'bot.usageLimit', args: { bot: 'Reviewer', until } } }), i18nT, now);
    expect(limit).toEqual({ title: `Reviewer: 사용량 한도에 도달해 ${formatNoticeTime(until, now)}에 다시 시작합니다`, body: "You've hit your session limit" });
    // A limit this build does not know keeps the English.
    expect(noticeText(card({ notice: { code: 'budget.exhausted', args: { bot: 'Reviewer', limit: 'tokens_week' } } }), i18nT, now)).toBeNull();
  });

  it('PR, verdict, hop, verify-gate, error and start-failure cards read in Korean; English matches what main writes', () => {
    const pr = card({ notice: { code: 'pr.merged', args: { pr: 5, title: 'Fix login' } } });
    expect(noticeText(pr, i18nT)?.title).toBe('PR #5 merged: Fix login');
    const verdict = card({ body: 'tests red', notice: { code: 'verdict.recorded', args: { verdict: 'fail', pr: 4, sha: 'abcdef1', bot: 'verifier' } } });
    expect(noticeText(verdict, i18nT)?.title).toBe('Verdict fail for #4 at abcdef1 by verifier');
    const relayed = card({ notice: { code: 'handoff.sent', args: { hop: 'result', to: '대장', title: 'add login', relay: 1 } } });
    expect(noticeText(relayed, i18nT)?.title).toBe('result → 대장: add login (forwarded by wmux)');
    const failed = card({ notice: { code: 'worker.startFailed', args: { title: 'x', cause: 'setup' } } });
    expect(noticeText(failed, i18nT)?.title).toBe('Worker for "x" could not start: its setup failed');
    setLocale('ko');
    expect(noticeText(pr, i18nT)?.title).toBe('PR #5 머지됨: Fix login');
    expect(noticeText(card({ notice: { code: 'pr.closed', args: { pr: 6 } } }), i18nT)?.title).toBe('PR #6 닫힘');
    expect(noticeText(verdict, i18nT)).toEqual({ title: '#4 판정 실패 (abcdef1, verifier)', body: 'tests red' });
    const hop = (h: string) => noticeText(card({ body: '', notice: { code: 'handoff.sent', args: { hop: h, to: '구현', title: 'add login' } } }), i18nT)?.title;
    expect(hop('dispatch')).toBe('구현에게 맡김: add login');
    expect(hop('result')).toBe('구현에게 결과: add login');
    expect(hop('message')).toBe('구현에게 메시지: add login');
    expect(hop('answer')).toBe('구현에게 답함: add login');
    expect(noticeText(relayed, i18nT)?.title).toBe('대장에게 결과: add login (wmux가 전달)');
    expect(noticeText(card({ notice: { code: 'thread.finished', args: { title: 'Ship it' } } }), i18nT)?.title).toBe('완료: Ship it');
    expect(noticeText(card({ notice: { code: 'thread.stopped', args: { title: 'Ship it' } } }), i18nT)?.title).toBe('중지됨: Ship it');
    expect(noticeText(card({ body: '`npm test` at abc1234', notice: { code: 'verify.failed', args: { exit: 1 } } }), i18nT))
      .toEqual({ title: '검증 게이트 실패 (종료 코드 1)', body: '`npm test` at abc1234' });
    expect(noticeText(card({ notice: { code: 'verify.skipped', args: { reason: 'deps_missing' } } }), i18nT)?.title).toBe('검증 게이트 건너뜀 (의존성이 설치되지 않음)');
    expect(noticeText(card({ notice: { code: 'verify.notRunNoWorktree' } }), i18nT)?.body).toBe('작업 워크트리가 디스크에 없어요.');
    expect(noticeText(card({ body: 'boom', notice: { code: 'bot.error', args: { bot: 'Reviewer' } } }), i18nT)).toEqual({ title: 'Reviewer: 오류가 발생했습니다', body: 'boom' });
    expect(noticeText(failed, i18nT)?.title).toBe('"x" 워커를 시작하지 못함: 준비 과정이 실패함');
  });

  it('keeps the English for a hop kind, verdict or start-failure cause this build does not know', () => {
    setLocale('ko');
    expect(noticeText(card({ notice: { code: 'handoff.sent', args: { hop: 'handoff', to: '구현', title: 'x' } } }), i18nT)).toBeNull();
    expect(noticeText(card({ notice: { code: 'handoff.sent', args: { to: '구현', title: 'x' } } }), i18nT)).toBeNull();
    expect(noticeText(card({ notice: { code: 'verdict.recorded', args: { verdict: 'maybe', pr: 4, sha: 'abc', bot: 'v' } } }), i18nT)).toBeNull();
    expect(noticeText(card({ notice: { code: 'worker.startFailed', args: { title: 'x', cause: 'cosmic_rays' } } }), i18nT)).toBeNull();
  });

  it('a slot-wait card words its holders in the reader\'s language; an older card keeps its English holders', () => {
    const args = { title: 'fix login', inUse: 4, cap: 4, holders: 'bot in a turn Dev; workers "a", "b"; 1 other worker starting, resumed or not yet reclaimed', bots: 'Dev', botCount: 1, workers: 'a\nb', workerCount: 2 };
    expect(noticeText(card({ notice: { code: 'worker.waiting', args } }), i18nT)?.body).toContain(': bot in a turn Dev; workers "a", "b"; 1 other worker starting, resumed or not yet reclaimed.');
    setLocale('ko');
    const ko = noticeText(card({ notice: { code: 'worker.waiting', args } }), i18nT)?.body ?? '';
    expect(ko).toContain('턴 진행 중인 봇 Dev; 워커 "a", "b"; 시작 중이거나 재개됐거나 아직 회수되지 않은 다른 워커 1개');
    expect(ko).not.toContain('bot in a turn');
    // More than shown: the rest is counted in the reader's words.
    const more = noticeText(card({ notice: { code: 'worker.waiting', args: { ...args, inUse: 9, workerCount: 8 } } }), i18nT)?.body ?? '';
    expect(more).toContain('워커 "a", "b" 외 6개');
    const old = noticeText(card({ notice: { code: 'worker.waiting', args: { title: 'x', inUse: 1, cap: 1, holders: 'bot in a turn Dev' } } }), i18nT)?.body ?? '';
    expect(old).toContain('bot in a turn Dev');
  });

  it('a skipped gate\'s reason in the reader\'s language; an unknown reason stays as written', () => {
    setLocale('ko');
    expect(noticeText(card({ notice: { code: 'gate.skipped', args: { reason: 'gate_unavailable' } } }), i18nT)?.title).toBe('게이트 건너뜀 (게이트 명령을 시작하지 못함): 작업은 열린 채로 둠');
    expect(noticeText(card({ notice: { code: 'gate.skipped', args: { reason: 'no_gate_command' } } }), i18nT)?.title).not.toContain('no_gate_command');
    expect(noticeText(card({ notice: { code: 'gate.skipped', args: { reason: 'deps_missing' } } }), i18nT)?.title).not.toContain('deps_missing');
    expect(noticeText(card({ notice: { code: 'gate.skipped', args: { reason: 'brand_new' } } }), i18nT)?.title).toBe('게이트 건너뜀 (brand_new): 작업은 열린 채로 둠');
    setLocale('en');
    expect(noticeText(card({ notice: { code: 'gate.skipped', args: { reason: 'gate_unavailable' } } }), i18nT)?.title).toBe('Gate skipped (the gate command could not start): task left open');
  });

  it('a task card\'s label in the reader\'s language, a stopped task Cancelled, its evidence body kept', () => {
    setLocale('ko');
    expect(noticeText(card({ notice: { code: 'task.done', args: { title: 'fix login' } } }), i18nT)).toEqual({ title: '작업 완료: fix login', body: 'English body' });
    expect(noticeText(card({ notice: { code: 'task.stoppedByOwner', args: { title: 'fix login' } } }), i18nT)?.title).toBe('작업 취소됨 · 직접 중지함: fix login');
    expect(noticeText(card({ notice: { code: 'task.reported', args: { title: 'fix login' } } }), i18nT)).toEqual({ title: '작업 보고됨 · 검토 대기: fix login', body: 'English body' });
    setLocale('en');
    expect(noticeText(card({ notice: { code: 'task.cancelled', args: { title: 'fix login' } } }), i18nT)?.title).toBe('Task cancelled: fix login');
  });

  it('formatNoticeTime: the time today, the date and time on another day', () => {
    const now = new Date(2026, 9, 16, 1, 0).getTime();
    expect(formatNoticeTime(new Date(2026, 9, 16, 2, 5).getTime(), now)).not.toMatch(/Oct|10/);
    expect(formatNoticeTime(new Date(2026, 9, 17, 2, 5).getTime(), now)).toMatch(/17/);
  });

  it('clock times follow the app\'s language, not the system\'s (round 7)', () => {
    const now = new Date(2026, 9, 16, 1, 0).getTime();
    const at = new Date(2026, 9, 16, 5, 44).getTime();
    const timeLocales = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    const dateLocales = vi.spyOn(Date.prototype, 'toLocaleDateString');
    try {
      setLocale('ko');
      expect(formatNoticeTime(at, now)).toBe(new Date(at).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' }));
      formatNoticeTime(new Date(2026, 9, 17, 2, 5).getTime(), now);
      formatCardTime(at, now);
      formatCardTime(new Date(2026, 9, 17, 2, 5).getTime(), now);
      noticeText(card({ notice: { code: 'budget.held', args: { bot: 'Reviewer', until: at } } }), i18nT, now);
      expect(timeLocales.mock.calls.map((c) => c[0])).not.toContain(undefined);
      expect(dateLocales.mock.calls.map((c) => c[0])).toEqual(['ko', 'ko']);
      expect(new Set(timeLocales.mock.calls.map((c) => c[0]))).toEqual(new Set(['ko']));
      setLocale('en');
      timeLocales.mockClear();
      formatNoticeTime(at, now);
      expect(timeLocales.mock.calls.map((c) => c[0])).toEqual(['en']);
    } finally {
      timeLocales.mockRestore();
      dateLocales.mockRestore();
    }
  });

  it('a resumable research worker\'s card speaks of its task folder, not a worktree', () => {
    for (const code of ['worker.doneResumable', 'worker.pausedResumable']) {
      const args: Record<string, string> = code === 'worker.doneResumable' ? { status: 'completed' } : {};
      setLocale('ko');
      expect(noticeText(card({ notice: { code, args: { ...args, kind: 'research' } } }), i18nT)?.body).toContain('작업 폴더와 대화');
      expect(noticeText(card({ notice: { code, args: { ...args, kind: 'research' } } }), i18nT)?.body).not.toContain('워크트리');
      expect(noticeText(card({ notice: { code, args } }), i18nT)?.body).toContain('워크트리와 대화');
      setLocale('en');
      expect(noticeText(card({ notice: { code, args: { ...args, kind: 'research' } } }), i18nT)?.body).toContain('task folder and the conversation are kept');
      for (const loc of ['pl', 'zh'] as const) {
        setLocale(loc);
        const research = noticeText(card({ notice: { code, args: { ...args, kind: 'research' } } }), i18nT)?.body;
        expect(research).toBeTruthy();
        expect(research).not.toBe(noticeText(card({ notice: { code, args } }), i18nT)?.body);
      }
      setLocale('en');
    }
    // A kind this build does not know keeps the card's English.
    expect(noticeText(card({ notice: { code: 'worker.doneResumable', args: { status: 'completed', kind: 'quantum' } } }), i18nT)).toBeNull();
  });

  it('English words match what main writes', () => {
    expect(noticeText(card({ notice: { code: 'worker.done', args: { status: 'failed' } } }), i18nT)?.body)
      .toBe('Task failed: its Claude stopped to free memory. Its pane stays open until you have looked at it, then closes. The worktree is kept; no conversation was recorded to resume.');
  });

  it('a card saying a stopped worker can resume offers Resume while its task\'s worker is resumable', () => {
    const paused = card({ notice: { code: 'worker.pausedResumable' }, refs: { taskId: 'wtask-a' } });
    expect(cardResumeTaskId(paused, (id) => id === 'wtask-a')).toBe('wtask-a');
    // Resumed since, or no task named: nothing.
    expect(cardResumeTaskId(paused, () => false)).toBeNull();
    expect(cardResumeTaskId(card({ notice: { code: 'worker.pausedResumable' } }), () => true)).toBeNull();
    expect(cardResumeTaskId(card({ notice: { code: 'worker.paused' }, refs: { taskId: 'wtask-a' } }), () => true)).toBeNull();
    expect(cardResumeTaskId(card({ actor: bot, notice: { code: 'worker.doneResumable' }, refs: { taskId: 'wtask-a' } }), () => true)).toBeNull();
  });
});

describe('actorLabel', () => {
  const botActor = { kind: 'bot' as const, workspaceId: 'ws-1', botId: 'bot-0000000d' };
  it('names a bot the runtime no longer lists by the name main keeps, a removed one marked so; never its legacy role', () => {
    expect(actorLabel(botActor, i18nT, [], { 'bot-0000000d': { role: 'lead', name: 'Developer' } })).toBe('Developer');
    expect(actorLabel(botActor, i18nT, [], { 'bot-0000000d': { role: 'lead', name: 'Developer', removed: true } })).toBe('Developer (removed)');
    expect(actorLabel(botActor, i18nT, [], { 'bot-0000000d': { role: 'lead' } })).toBe(i18nT('room.role.lead'));
    expect(actorLabel(botActor, i18nT, [], {})).toBe('Bot');
  });
});

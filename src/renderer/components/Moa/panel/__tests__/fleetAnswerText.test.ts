import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_OPTIONS, setLocale, t, type Locale } from '../../../../i18n';
import type { FleetLocalAnswer } from '../../../../../shared/fleetLocalAnswer';
import { formatFleetAnswer, isPluralOne } from '../fleetAnswerText';

const LOCALES = LOCALE_OPTIONS.map((o) => o.value);

function answer(overrides: Partial<FleetLocalAnswer> = {}): FleetLocalAnswer {
  return {
    intent: 'status',
    counts: { needsYou: 0, finished: 0, running: 0, idle: 0 },
    rows: [],
    limited: false,
    ...overrides,
  };
}

const counts = (n: number) => ({ needsYou: n, finished: n, running: n, idle: n });

function inLocale(locale: Locale, value: FleetLocalAnswer): string {
  setLocale(locale);
  return formatFleetAnswer(value, t, locale);
}

afterEach(() => setLocale('en'));

describe('formatFleetAnswer — English', () => {
  it('words an empty board for every question', () => {
    expect(inLocale('en', answer())).toBe([
      'Fleet snapshot (local data, answered without Moa):',
      '0 need you · 0 turns finished · 0 running · 0 idle.',
    ].join('\n'));
    expect(inLocale('en', answer({ intent: 'needs_you' }))).toBe([
      'Fleet snapshot (local data, answered without Moa):',
      '0 tasks need your attention.',
    ].join('\n'));
    expect(inLocale('en', answer({ intent: 'finished' }))).toBe([
      'Fleet snapshot (local data, answered without Moa):',
      '0 turns finished. A finished turn does not verify task or test success.',
    ].join('\n'));
  });

  it('uses the singular for exactly one and the plural otherwise', () => {
    expect(inLocale('en', answer({ intent: 'needs_you', counts: counts(1) }))).toContain('\n1 task needs your attention.');
    expect(inLocale('en', answer({ intent: 'needs_you', counts: counts(2) }))).toContain('\n2 tasks need your attention.');
    expect(inLocale('en', answer({ intent: 'finished', counts: counts(1) }))).toContain('\n1 turn finished. A finished turn');
    expect(inLocale('en', answer({ intent: 'finished', counts: counts(3) }))).toContain('\n3 turns finished. A finished turn');
    expect(inLocale('en', answer({ counts: counts(1) }))).toContain('\n1 needs you · 1 turn finished · 1 running · 1 idle.');
    expect(inLocale('en', answer({ counts: { needsYou: 18, finished: 3, running: 4, idle: 7 } })))
      .toContain('\n18 need you · 3 turns finished · 4 running · 7 idle.');
  });

  it('lists rows with fixed reason words and points at Fleet when rows were left out', () => {
    const text = inLocale('en', answer({
      intent: 'needs_you',
      counts: { needsYou: 6, finished: 1, running: 0, idle: 0 },
      rows: [
        { title: 'Review request', workspaceName: 'Main', reason: 'input' },
        { title: 'Build', workspaceName: 'CI', reason: 'error' },
        { title: 'Deploy', workspaceName: 'Ops', reason: 'unconfirmed' },
        { title: 'Watcher', workspaceName: 'Ops', reason: 'supervisionStopped' },
        { title: 'Docs', workspaceName: 'Main', reason: 'complete' },
      ],
      limited: true,
    }));
    expect(text.split('\n')).toEqual([
      'Fleet snapshot (local data, answered without Moa):',
      '6 tasks need your attention.',
      '- Review request (Main): needs input',
      '- Build (CI): error',
      '- Deploy (Ops): unconfirmed',
      '- Watcher (Ops): supervision stopped',
      '- Docs (Main): turn finished',
      'Some rows are omitted. Open Fleet for the full board.',
    ]);
  });

  it('words an empty label as untitled', () => {
    const text = inLocale('en', answer({ intent: 'needs_you', counts: counts(1), rows: [{ title: '', workspaceName: '', reason: 'input' }] }));
    expect(text).toContain('- (untitled) ((untitled)): needs input');
  });

  it('substitutes row values in one pass, so a title cannot pull in another field', () => {
    const text = inLocale('en', answer({ intent: 'needs_you', counts: counts(1), rows: [{ title: '{workspace} {reason}', workspaceName: '{title}', reason: 'input' }] }));
    expect(text).toContain('- {workspace} {reason} ({title}): needs input');
  });
});

describe('formatFleetAnswer — Korean', () => {
  it('reads naturally for an empty and a non-empty board', () => {
    expect(inLocale('ko', answer())).toBe([
      'Fleet 현황 (이 컴퓨터의 데이터로, Moa 없이 답했습니다):',
      '확인 필요 0 · 끝난 턴 0 · 실행 중 0 · 유휴 0',
    ].join('\n'));
    expect(inLocale('ko', answer({
      intent: 'needs_you',
      counts: { needsYou: 1, finished: 0, running: 0, idle: 0 },
      rows: [{ title: '리뷰 요청', workspaceName: '메인', reason: 'input' }],
    }))).toBe([
      'Fleet 현황 (이 컴퓨터의 데이터로, Moa 없이 답했습니다):',
      '확인이 필요한 작업: 1개',
      '- 리뷰 요청 (메인): 입력 대기 중',
    ].join('\n'));
    expect(inLocale('ko', answer({ intent: 'finished', counts: counts(3), limited: true }))).toBe([
      'Fleet 현황 (이 컴퓨터의 데이터로, Moa 없이 답했습니다):',
      '끝난 턴: 3개. 턴이 끝났다고 해서 작업이나 테스트가 성공했다는 뜻은 아닙니다.',
      '일부 항목은 생략했습니다. 전체 보드는 Fleet에서 확인하세요.',
    ].join('\n'));
  });
});

describe('formatFleetAnswer — plural rules beyond one/other', () => {
  it('Polish: one for 1, a count label for 2, 5 and 22', () => {
    expect(inLocale('pl', answer({ intent: 'needs_you', counts: counts(1) }))).toContain('\n1 zadanie wymaga Twojej uwagi.');
    for (const n of [0, 2, 5, 22]) {
      expect(inLocale('pl', answer({ intent: 'needs_you', counts: counts(n) }))).toContain(`\nZadania wymagające Twojej uwagi: ${n}.`);
      expect(inLocale('pl', answer({ intent: 'finished', counts: counts(n) }))).toContain(`\nZakończone tury: ${n}.`);
    }
    expect(inLocale('pl', answer({ counts: counts(2) }))).toContain('\nCzeka na Ciebie: 2 · Zakończone tury: 2 · Pracuje: 2 · Bezczynne: 2.');
  });

  it('Russian and Ukrainian: 21 takes the singular, 3 and 11 the count label', () => {
    expect(inLocale('ru', answer({ intent: 'needs_you', counts: counts(21) }))).toContain('\n21 задача требует вашего внимания.');
    expect(inLocale('ru', answer({ intent: 'needs_you', counts: counts(3) }))).toContain('\nЗадачи, требующие вашего внимания: 3.');
    expect(inLocale('ru', answer({ intent: 'needs_you', counts: counts(11) }))).toContain('\nЗадачи, требующие вашего внимания: 11.');
    expect(inLocale('uk', answer({ intent: 'needs_you', counts: counts(21) }))).toContain('\n21 завдання потребує вашої уваги.');
    expect(inLocale('uk', answer({ intent: 'needs_you', counts: counts(5) }))).toContain('\nЗавдання, що потребують вашої уваги: 5.');
  });

  it('French and Brazilian Portuguese: 0 is singular', () => {
    expect(inLocale('fr', answer({ intent: 'needs_you' }))).toContain('\n0 tâche requiert votre attention.');
    expect(inLocale('fr', answer({ intent: 'needs_you', counts: counts(2) }))).toContain('\n2 tâches requièrent votre attention.');
    expect(inLocale('pt-BR', answer({ intent: 'needs_you' }))).toContain('\n0 tarefa precisa da sua atenção.');
    expect(inLocale('pt-BR', answer({ intent: 'needs_you', counts: counts(2) }))).toContain('\n2 tarefas precisam da sua atenção.');
  });

  it('German and Spanish: 0 is plural', () => {
    expect(inLocale('de', answer({ intent: 'needs_you' }))).toContain('\n0 Aufgaben benötigen Ihre Aufmerksamkeit.');
    expect(inLocale('es', answer({ intent: 'needs_you', counts: counts(1) }))).toContain('\n1 tarea necesita tu atención.');
  });

  it('resolves the plural rule for region-tagged locales and falls back to English for an unknown tag', () => {
    expect(isPluralOne('pt-BR', 0)).toBe(true);
    expect(isPluralOne('zh-TW', 1)).toBe(false);
    expect(isPluralOne('ru', 21)).toBe(true);
    expect(isPluralOne('not a locale!', 1)).toBe(true);
    expect(isPluralOne('not a locale!', 0)).toBe(false);
  });
});

describe('formatFleetAnswer — every shipped locale', () => {
  const full = answer({
    intent: 'status',
    counts: { needsYou: 2, finished: 1, running: 5, idle: 21 },
    rows: [
      { title: 'Alpha', workspaceName: 'One', reason: 'input' },
      { title: 'Beta', workspaceName: 'Two', reason: 'complete' },
    ],
    limited: true,
  });

  it.each(LOCALES)('%s words empty, singular and plural answers in its own language', (locale) => {
    const english = (value: FleetLocalAnswer) => inLocale('en', value);
    for (const value of [
      answer(), answer({ intent: 'needs_you' }), answer({ intent: 'finished' }),
      answer({ intent: 'needs_you', counts: counts(1) }), answer({ intent: 'finished', counts: counts(7) }),
      full,
    ]) {
      const text = inLocale(locale, value);
      // Every placeholder was filled and no key name leaked through.
      expect(text).not.toMatch(/\{[a-z]+\}/i);
      expect(text).not.toContain('moa.fleetAnswer');
      if (locale !== 'en') expect(text).not.toBe(english(value));
    }
    const text = inLocale(locale, full);
    for (const value of ['Alpha', 'One', 'Beta', 'Two', '2', '5', '21']) expect(text).toContain(value);
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    // Intro, heading, two rows, the omitted note.
    expect(text.split('\n')).toHaveLength(5);
  });
});

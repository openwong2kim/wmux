// The words for a Moa Fleet fast-path answer (main/deck/fleetFastPath.ts).
//
// Main ships the board's counts and sanitized rows; this writes them in the
// UI language. Counted phrases come in `.one` / `.other` pairs, and the pair
// is chosen by the locale's own plural rule, not by `count === 1`: French and
// Portuguese treat 0 as singular, Russian, Ukrainian and Bosnian treat 21 as
// singular. Each locale's `.other` string is written to read correctly for
// every count its `.one` does not cover (a "label: N" form where the language
// has more than two plural forms).

import { getLocale, t as translate } from '../../../i18n';
import type { FleetAnswerReason, FleetLocalAnswer } from '../../../../shared/fleetLocalAnswer';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const REASON_KEYS: Record<FleetAnswerReason, string> = {
  input: 'moa.fleetAnswer.reason.input',
  error: 'moa.fleetAnswer.reason.error',
  unconfirmed: 'moa.fleetAnswer.reason.unconfirmed',
  supervisionStopped: 'moa.fleetAnswer.reason.supervisionStopped',
  complete: 'moa.fleetAnswer.reason.complete',
};

const pluralRules = new Map<string, Intl.PluralRules | null>();

/** True when `count` takes the locale's singular (`one`) form. */
export function isPluralOne(locale: string, count: number): boolean {
  if (!pluralRules.has(locale)) {
    let rules: Intl.PluralRules | null = null;
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      // An unknown tag: fall back to the English rule below.
    }
    pluralRules.set(locale, rules);
  }
  const rules = pluralRules.get(locale);
  return rules ? rules.select(count) === 'one' : count === 1;
}

/** The answer as Markdown text: an intro line, a heading, up to twelve
 *  `- ` rows, and a pointer to Fleet when rows were left out. */
export function formatFleetAnswer(
  answer: FleetLocalAnswer,
  t: Translate = translate,
  locale: string = getLocale(),
): string {
  const counted = (base: string, count: number) =>
    t(`${base}.${isPluralOne(locale, count) ? 'one' : 'other'}`, { count });
  const { counts } = answer;
  const heading = answer.intent === 'needs_you'
    ? counted('moa.fleetAnswer.needsYou', counts.needsYou)
    : answer.intent === 'finished'
      ? counted('moa.fleetAnswer.finished', counts.finished)
      : t('moa.fleetAnswer.status.sentence', {
        clauses: [
          counted('moa.fleetAnswer.status.needsYou', counts.needsYou),
          counted('moa.fleetAnswer.status.finished', counts.finished),
          counted('moa.fleetAnswer.status.running', counts.running),
          counted('moa.fleetAnswer.status.idle', counts.idle),
        ].join(t('moa.fleetAnswer.status.join')),
      });
  const untitled = t('moa.fleetAnswer.untitled');
  const rowTemplate = t('moa.fleetAnswer.row');
  const rows = answer.rows.map((row) => {
    const values: Record<string, string> = {
      title: row.title || untitled,
      workspace: row.workspaceName || untitled,
      reason: REASON_KEYS[row.reason] ? t(REASON_KEYS[row.reason]) : String(row.reason),
    };
    // One pass: a title that itself reads "{workspace}" stays literal.
    return `- ${rowTemplate.replace(/\{(title|workspace|reason)\}/g, (_m, key: string) => values[key])}`;
  });
  return [
    t('moa.fleetAnswer.intro'),
    heading,
    ...rows,
    ...(answer.limited ? [t('moa.fleetAnswer.omitted')] : []),
  ].join('\n');
}

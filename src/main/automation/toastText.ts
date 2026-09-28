/**
 * OS toast wording for scheduled runs. The whole text is `<name> · <status>`:
 * a toast is read away from wmux, often on a locked or shared screen, so the
 * prompt and the run's output never ride in it. Kept pure so a test can pin
 * that nothing else leaks in.
 */
export type AutomationToastKind = 'awaiting' | 'failed' | 'proposed' | 'grantRaised';
export type AutomationToastLabels = Record<AutomationToastKind, string>;

/**
 * Main owns the words (en / ko; every other locale falls back to en). The
 * renderer only says which locale it runs, so it cannot make a toast say
 * anything a status word would not.
 */
const LABELS: Record<'en' | 'ko', AutomationToastLabels> = {
  en: { awaiting: 'Needs your response', failed: 'Failed', proposed: 'Draft to review', grantRaised: 'Permission raised' },
  ko: { awaiting: '응답 대기', failed: '실패', proposed: '검토할 초안', grantRaised: '권한 상승' },
};

export const DEFAULT_AUTOMATION_TOAST_LABELS: AutomationToastLabels = LABELS.en;

export type AutomationUiLocale = 'en' | 'ko';

export function coerceUiLocale(input: unknown): AutomationUiLocale {
  return input === 'ko' ? 'ko' : 'en';
}

export function toastLabelsFor(locale: AutomationUiLocale): AutomationToastLabels {
  return LABELS[locale];
}

/** Main-owned copy for the native Bypass confirmation. */
export function bypassConfirmCopy(locale: AutomationUiLocale, automationName: string): {
  message: string; detail: string; confirm: string; cancel: string;
} {
  const name = oneLine(automationName, NAME_MAX) || 'wmux';
  return locale === 'ko'
    ? {
      message: `"${name}"을(를) 승인 없이 실행할까요?`,
      detail: '정한 시각에, 자리에 없을 때도 승인을 묻지 않고 실행합니다.',
      confirm: '바이패스 사용',
      cancel: '취소',
    }
    : {
      message: `Run "${name}" without asking for approval?`,
      detail: 'It runs at the scheduled time without asking for approval, including while you are away.',
      confirm: 'Use Bypass',
      cancel: 'Cancel',
    };
}

const NAME_MAX = 80;
// C0/C1 controls and line breaks: a name is one line in a toast.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function oneLine(value: string, max: number): string {
  const flat = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  // By code point: slicing UTF-16 units can split a surrogate pair.
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat;
}

export function automationToastText(
  automationName: string,
  kind: AutomationToastKind,
  labels: AutomationToastLabels = DEFAULT_AUTOMATION_TOAST_LABELS,
): string {
  const name = oneLine(automationName, NAME_MAX) || 'wmux';
  return `${name} · ${labels[kind]}`;
}

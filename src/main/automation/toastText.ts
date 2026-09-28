/**
 * OS toast wording for scheduled runs. The whole text is `<name> · <status>`:
 * a toast is read away from wmux, often on a locked or shared screen, so the
 * prompt and the run's output never ride in it. Kept pure so a test can pin
 * that nothing else leaks in.
 */
export type AutomationToastKind = 'awaiting' | 'failed' | 'proposed' | 'grantRaised';
export type AutomationToastLabels = Record<AutomationToastKind, string>;

/** English fallback until the renderer hands over its locale's words. */
export const DEFAULT_AUTOMATION_TOAST_LABELS: AutomationToastLabels = {
  awaiting: 'Needs your response',
  failed: 'Failed',
  proposed: 'Draft to review',
  grantRaised: 'Permission raised',
};

const NAME_MAX = 80;
const LABEL_MAX = 60;
// C0/C1 controls and line breaks: a name is one line in a toast.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function oneLine(value: string, max: number): string {
  const flat = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function automationToastText(
  automationName: string,
  kind: AutomationToastKind,
  labels: AutomationToastLabels = DEFAULT_AUTOMATION_TOAST_LABELS,
): string {
  const name = oneLine(automationName, NAME_MAX) || 'wmux';
  return `${name} · ${labels[kind]}`;
}

/** Accept a renderer-supplied label map only when every entry is a short string. */
export function coerceToastLabels(input: unknown): AutomationToastLabels | null {
  if (!input || typeof input !== 'object') return null;
  const src = input as Record<string, unknown>;
  const out = { ...DEFAULT_AUTOMATION_TOAST_LABELS };
  for (const key of Object.keys(out) as AutomationToastKind[]) {
    const value = src[key];
    if (typeof value !== 'string') return null;
    const clean = oneLine(value, LABEL_MAX);
    if (!clean) return null;
    out[key] = clean;
  }
  return out;
}

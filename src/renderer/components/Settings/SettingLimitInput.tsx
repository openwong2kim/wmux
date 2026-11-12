import { useEffect, useState } from 'react';
import Input from '../ui/Input';

// ─── Optional limit (a count the owner may leave unset) ──────────────────────
//
// The same field as the other number settings, empty when no limit is set:
// its placeholder says so. Commits on blur or Enter; an empty field is no
// limit (null), a whole number in range is that limit, and anything else goes
// back to the value in force.

export function SettingLimitInput({
  value,
  onCommit,
  max,
  label,
  noLimitLabel,
  testId,
}: {
  /** null or undefined: no limit. */
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  max: number;
  label: string;
  noLimitLabel: string;
  testId?: string;
}) {
  const shown = value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  const commit = () => {
    const text = draft.trim();
    if (text === '') {
      if (shown !== '') onCommit(null);
      return;
    }
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= max) {
      if (String(n) !== shown) onCommit(n);
      setDraft(String(n));
      return;
    }
    setDraft(shown);
  };
  return (
    <Input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      placeholder={noLimitLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      className="settings-input tabular-nums text-center"
      style={{ width: 96 }}
      data-testid={testId}
    />
  );
}

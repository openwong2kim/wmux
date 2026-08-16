import React from 'react';

/**
 * Render a whole-sentence translation whose `{slot}` placeholders are React
 * nodes rather than strings.
 *
 * Splitting a sentence into `…Intro` / `…Mid` / `…End` keys and holding the
 * word order in JSX cannot be translated: Korean, Japanese and Turkish put the
 * verb last and Arabic runs the other way, so no filling of those slots in
 * that fixed order produces a correct sentence — and a translator receives
 * "An agent in" as a unit with nothing to attach it to. Keeping the sentence
 * in ONE key lets the translator move the slots; this renders it back with the
 * emphasised spans intact.
 *
 * The template is the RAW value from `t(key)` — call it without `vars` so the
 * placeholders survive to be split on here.
 */
export function renderSentence(
  template: string,
  slots: Record<string, React.ReactNode>,
): React.ReactNode[] {
  return template.split(/(\{[A-Za-z0-9_]+\})/g).map((part, i) => {
    const name = /^\{([A-Za-z0-9_]+)\}$/.exec(part)?.[1];
    if (name !== undefined && Object.prototype.hasOwnProperty.call(slots, name)) {
      return <React.Fragment key={`${name}-${i}`}>{slots[name]}</React.Fragment>;
    }
    // An unknown placeholder is left verbatim rather than dropped: a
    // translation that renames a slot should be visibly wrong, not silently
    // missing a word.
    return <React.Fragment key={`text-${i}`}>{part}</React.Fragment>;
  });
}

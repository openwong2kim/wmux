### Changed

- The UI now renders in Inter, the typeface the design system has always
  specified. It is bundled with the app under the SIL Open Font License (Latin +
  Latin Extended, +131 KB, full 100–900 weight range), so it looks the same on
  every machine instead of falling back to whatever the OS supplies. Text
  outside those scripts, including Hangul, still uses the system face.
- Every UI text size now lands on one of the four design steps — 10px section
  labels, 11px meta and tool lines, 13px body, 14px titles. 116 places were
  drifting onto in-between sizes (8, 9, 10.5, 11.5, 12.5px) that blurred the
  hierarchy without adding one. Terminal text is unaffected.
- Corner radii follow the design system again: 5px on buttons and controls,
  7px on cards, panels, popovers and dialogs. 75 surfaces were rounder than the
  chrome allows.
- Inline `code` in the orchestrator's replies is now mono on a quiet surface
  instead of amber, and the workspace Mode control is a plain label with a
  status dot (red for danger, amber for assist, gray for off) instead of a
  tinted pill. Amber is reserved for things that are alive or need you, and a
  single screen was spending it on dozens of code spans and an idle control.
- Modal dimming, inset highlights and hairlines now derive from theme tokens
  rather than hardcoded white and black. Light themes were getting a highlight
  lit the wrong way, and 33 colours carried a hardcoded fallback from an
  unrelated palette that would have surfaced if a theme token ever went missing.
- The two light themes now dim behind a dialog more gently than the dark ones,
  where the previous single value read as a blackout rather than a dimming.

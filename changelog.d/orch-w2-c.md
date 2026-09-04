### Added

- Channel composer now tells you where an @mention will actually land: a mention
  of a roster member is pinned to that workspace's most recently active agent
  pane (the only shape that reaches an idle agent), with a "will reach …" hint
  under the input. A member with no live agent pane is offered as a badge-only
  mention and labelled as one instead of silently reaching nobody.
- Channel messages you post now show what actually happened to them: delivered
  as soon as any recipient got it, target gone when none did, and "no answer —
  nudges exhausted" when the wake worker gave up on a mentioned agent. A post
  that never gets an outcome now reads "delivery unconfirmed" instead of
  claiming to still be sending forever.

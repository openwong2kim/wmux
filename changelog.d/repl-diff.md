### Changed

- **`browser_repl` snapshots return a diff again, with the refs still
  complete.** A `browser.snapshot()` or `browser.smart_snapshot()` inside a
  script used to be forced to render the whole tree, because the script's
  `refs[]` was parsed out of the returned text and a diff names only what
  moved — so an act-then-verify loop paid for a full listing on every
  iteration (a Node.js API page cost about 78 KB and 7–8 seconds each time,
  where the direct tool answered with a few lines). The handler now hands the
  bridge the complete listing alongside whatever it returned, so the script's
  `text` is the ordinary diff-or-full the direct tools give — its first line
  still says `[snapshot: full]` or `[snapshot: diff …]` — while `refs[]` keeps
  every element on the page. `full: true` still forces the whole tree, and the
  entries are unchanged: `ref` is a string for `snapshot`, a number for
  `smart_snapshot`.

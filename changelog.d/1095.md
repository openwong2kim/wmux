### Changed

- **`browser_snapshot` no longer repeats every piece of text three times.**
  Chrome stacks a `StaticText` and an `InlineTextBox` under each rendered
  string, so `<h1>Dogfood page</h1>` cost three identical lines and a button
  cost three lines to say one word — over half the output on a real page. The
  `ai` format now drops `InlineTextBox` (the layout engine's per-line fragment
  of its parent, measured to never carry text the parent lacks) and drops a
  `StaticText` only when it is its parent's only child and repeats the parent's
  own name. Measured against live pages: Wikipedia 204,276 → 115,648 chars
  (−43%), Hacker News 59,783 → 29,874 (−50%), with byte-identical ref numbering
  and no non-text line removed. `format:"aria"` is unchanged — its contract is
  the whole tree.

### Added

- **`browser_snapshot` marks the overlay it warns about.** The note already
  named the covering layer (`div#backdrop`), but nothing in the tree said which
  node that was, so the two could not be connected. The layer's line now
  carries an `overlay` marker next to the `clickable` marks on the controls
  still reachable behind it. Best-effort: a backdrop with no accessibility node
  of its own leaves the note standing alone, as before.

### Fixed

- **`browser_session_status` said `running` without saying running *what*.**
  Its description now states that the field reports whether this workspace's
  Chrome is already up, that the call is a pure read which launches nothing,
  and — the part that cost a dogfood run a wrong turn — that `running:false`
  does not mean you have to call `browser_session_start`, because the first
  browser tool call starts what it needs on its own.
- **`browser_evaluate` now says where its blocklist draws the line.** The
  description said only "a text scan", which reads as a substring match under
  which ordinary identifiers like `retrieval` or `evaluateScore` would be
  refused. It is a case-sensitive whole-word scan: `fetch`/`eval`/`require`/
  `import` match only in call form, everything else matches the bare word
  anywhere including inside strings and comments.
- **`browser_snapshot` documents its line markers.** `focused`, `overlay`,
  `clickable` and the iframe boundary note were all readable in the output and
  absent from the description, leaving an agent to infer them from a snapshot
  it had already paid for.

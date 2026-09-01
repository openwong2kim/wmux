### Added

- **A browser flow that worked can be replayed without reading a snapshot.**
  An agent repeating the same web task — log in, filter a report, export a
  CSV — used to pay for a full accessibility snapshot on every step, every
  time. Successful browser actions are now recorded automatically, and the new
  `browser_replay` tool names the last run of a flow (`save`), repeats it
  (`run`), lists what has been recorded, and deletes one. A replay resolves its
  elements internally and returns no snapshot at all, which is where the saving
  is. Flows are stored per workspace by the wmux app rather than by the MCP
  session, so they survive the session ending — and one workspace can never see
  another's. Needs the chrome browser backend, since flows are keyed on what the
  accessibility snapshot calls each element. See
  [Replay a browser flow](docs/how-to/replay-browser-flows.md).

- **A replay that cannot find an element hands the page back rather than
  guessing.** Elements are re-found by what the snapshot called them — role,
  accessible name, and position among the same-named elements in the same
  frame — so a page whose refs were renumbered, or which was restructured
  around the button, still replays. When a step's element is genuinely gone the
  run stops at that step and reports which, why, and how the page's shape
  compares to the recording, leaving the page exactly there so the flow can be
  finished by hand and re-saved. A flow is also refused outright when run from
  a page it was not recorded on, and when the count of same-named elements
  changed under a step that was not addressing the first of them — a row
  inserted above shifts the rest, and replaying position N would act on
  whatever moved into that slot.

- **After a navigation, wmux names the recorded flows for the page you landed
  on.** One line, only on a landing, and only for flows that have actually
  worked and are not quarantined — not a snapshot footer, which would spend
  more context than the feature saves.

- **A password is never stored, and a flow containing one refuses to run.** A
  `browser_type` or `browser_fill` into a password field is recorded as a
  marked hole whose value was never captured, so it cannot reach the stored
  flow or the cache file — and `browser_fill` decides this per field, so the
  ordinary fields of a login form are still recorded normally. A URL carrying a
  credential is stripped and holed the same way. The same treatment covers an
  action that fell back to the RPC transport and an argument too long to store
  intact; coordinate clicks are not recorded at all, because a coordinate does
  not survive a re-render. Values that should vary between runs are stored as
  `{{placeholders}}` and supplied at replay time.

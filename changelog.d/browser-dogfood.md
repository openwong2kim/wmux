### Added

- `browser_type` takes a `selector`, for an element neither snapshot handed out a number for. It is CSS on every transport — a Playwright engine prefix (`text=`, `xpath=`, `>>`) is refused rather than accepted on one lane and not the others — and it must match exactly one element, the same uniqueness rule a ref carries.
- `browser_type` takes `newline: 'enter' | 'shift-enter'`, which splits the text on `\n` and presses a real key between the lines instead of inserting a newline character a single-line input or a rich-text editor drops. Default stays `literal`, today's behaviour. If a keypress submits the field, the remaining lines are not typed into whatever the next page focuses: the type stops and reports how many lines went in.
- `browser_snapshot` takes `q`, keeping only the nodes that match it (case-insensitive substring, or `/pattern/flags`) plus their ancestors — a way to ask a 250-option listbox one question instead of reading it whole.

### Fixed

- `browser_type` and `browser_fill` now accept `smartRef` (from `browser_smart_snapshot`) as well as `ref`, the way `browser_click` already did. A smart ref passed as `ref` no longer reads as a missing element: the error names which ref space the argument was read in and which parameter the number belongs to.
- `contenteditable` fields (a rich-text title or caption) now count as interactive in `browser_snapshot`, page-level and under a `selector`. They were absent from `filter: 'interactive'` entirely, so a dialog built out of them looked like it had no fields.
- On the RPC transport (a surface with no live Chrome page), `browser_fill` and `browser_type` stop when the element they were pointed at did not take focus, instead of typing over whichever field the page had focused. A `smartRef` is refused there rather than resolved through a `browser_snapshot` tag that numbers a different element.
- The `LIVE_CHROME_UNAVAILABLE` hint names the "Remote debugging" item in the `chrome://inspect` sidebar. Its old `chrome://inspect/#remote-debugging` link opens the Devices tab, leaving the user on the wrong page.

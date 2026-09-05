### Changed

- **Every glyph in the chrome is now a target you can actually hit.** An audit
  of the packaged window found 66 controls under the 24px pointer floor: the
  pane tab's close was a 7px glyph with no box at all, the workspace row's
  hover actions were 11px icons in 13px boxes, the dock toggle was 20x20. They
  now carry real 24x24 hit areas on the same drawing — and no box reaches over
  its neighbour to do it, so the workspace row's close button cannot take a
  click meant for Copy, and the tab close cannot take one meant for the end of
  the tab's name. The hover actions also stop accepting clicks while they are
  invisible, and appear for the keyboard when one of them is focused.

- **Icon-only buttons say what they are.** The titlebar's settings gear was an
  unnamed button to a screen reader — a `title` tooltip is not an accessible
  name when the button's only child is an SVG. The gear, the sidebar's collapse
  chevron, the pane tab close (which now names the tab it closes, not just
  "Close tab"), the company panel's add and destroy glyphs, the profile modal's
  row remove and the mini sidebar's unread count all announce themselves now.

- **Copy that repeated a control is gone.** The orchestrator deck's empty state
  was a three-line paragraph saying what the composer's own placeholder says one
  row below it, so the thread simply stays empty until there is something in it.
  The new-workspace menu's "Browse Folder…" row now tells you something ("Choose
  any folder on disk") instead of restating its own label. The schedules empty
  state keeps the fact you cannot infer — they survive reboots — and drops the
  sentence describing what a schedule is.

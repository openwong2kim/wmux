### Changed

- **Every glyph in the chrome is now a target you can actually hit.** An audit
  of the packaged window found 66 controls under the 24px pointer floor: the
  pane tab's close was a 7px glyph with no box at all, the workspace row's
  hover actions were 11px icons in 13px boxes, the dock toggle was 20x20. All
  of them now carry a real 24x24 hit area on the same drawing — in the dense
  sidebar row the extra width is refunded with a negative margin, so the
  workspace name keeps every pixel it had.

- **Icon-only buttons say what they are.** The titlebar's settings gear was an
  unnamed button to a screen reader — a `title` tooltip is not an accessible
  name when the button's only child is an SVG. The gear, the sidebar's collapse
  chevron, the pane tab close (which now names the tab it closes, not just
  "Close tab"), the company panel's add and destroy glyphs, the profile modal's
  row remove and the mini sidebar's unread count all announce themselves now.

- **Three lines of copy that repeated a control are gone.** The orchestrator
  deck's empty state was a three-line paragraph saying what the composer's own
  placeholder says one row below it, so the thread simply stays empty until
  there is something in it. The new-workspace menu no longer explains that
  "Browse Folder…" picks a folder as a workspace. The schedules empty state
  keeps the fact you cannot infer (they survive reboots) and drops the sentence
  describing what a schedule is.

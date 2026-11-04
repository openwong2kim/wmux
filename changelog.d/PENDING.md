### Added

- **The phone's live browser stream covers builtin browser panes too, behind
  the same flag.** With `WMUX_PHONE_BROWSER_STREAM=1` on the desktop, a phone
  that sees the browser preview can open `GET …/browser/stream` on a builtin
  pane as well as on a dedicated wmux Chrome tab. It receives the pane's
  frames as the page repaints, its URL as it changes, and `hidden` as soon as
  the pane is off screen on the Mac (another workspace or tab selected, the
  window minimized), then `live` with a frame when it is back. The stream
  ends when the pane is closed or unloaded to save memory. Taps and scrolls
  on a streamed pane map by the frame the phone saw, as on Chrome. The flag
  is still off by default. (#PENDING)

### Fixed

- **A phone watching an animated page no longer makes the desktop capture
  it at full speed.** The browser kept capturing and encoding every frame
  the page painted, even when the phone asked for one frame a second, and
  main discarded the rest: one tab at 1 fps cost about as much CPU as at
  15 fps. The browser now captures two or three frames for each frame the
  stream sends, and the frame sent is still at most about 100 ms old.
  (#PENDING)
- **Streams over the desktop's shared budget arrive evenly.** With several
  busy tabs streaming at once, each phone got a burst of frames and then
  nearly a second of nothing; frames are now spaced evenly within the
  budget. (#PENDING)
- **A refused stream push is logged.** The daemon writes one line at most
  every 10 s per connection with the number of browser stream pushes it
  refused, where before nothing recorded them. (#PENDING)

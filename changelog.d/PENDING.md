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

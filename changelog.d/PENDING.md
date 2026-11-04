### Added

- **The phone's live browser stream can show a tab as a phone.** A stream
  opened with `viewport=mobile` lays the tab out as a phone while any phone
  watching it asks for it: a dedicated wmux Chrome tab at 390 pixels wide
  and 2x with touch, a builtin pane through the phone's existing mobile
  viewport. Taps and scrolls land as they do on any streamed frame. The
  Mac's own view of the tab changes with it. The tab goes back about 4 s
  after the last phone that asked leaves, so a quick reconnect neither
  reloads nor flips it, and at once when the desktop loses its connection
  to the server. (#PENDING)

### Changed

- **The phone's live browser stream is on by default.** A phone that sees
  the browser preview gets `browserStream: true` without any setting on the
  desktop; `WMUX_PHONE_BROWSER_STREAM=0` on the desktop turns the stream
  off. (#PENDING)

### Fixed

- **A streamed tab with large frames no longer stalls behind lighter tabs.**
  When several streamed tabs shared the desktop's frame budget, a tab whose
  frames were large could get none at all while tabs with smaller frames
  kept going. Tabs that have to wait now take turns. (#PENDING)

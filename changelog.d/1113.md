### Fixed

- Browser tools called without a `surfaceId` now target your **most recently
  opened** browser surface, not the oldest one. Previously, right after
  `browser_tabs new` (or `browser_open`) handed back a surfaceId, a follow-up
  tool call that omitted it could silently act on a leftover tab from an earlier
  run — the snapshot looked normal and only a stray action (a download, a click)
  failed, so nothing revealed that the wrong page was being driven.
  `browser_tabs` and `browser_open` now document this default; pass a `surfaceId`
  to act on any earlier tab.

### Fixed

- Browser (`chrome` backend): when Chrome replaces the page behind one of your
  tabs — the first-run sync flow is the common case — the agent's tab handle
  now follows it over immediately instead of going quiet until the tab is
  reopened. wmux anchors each tab it opens to Chrome's own tab target, which
  survives the replacement, and re-points the handle the moment the successor
  page appears. The same anchor is what lets a handle come back after a wmux
  restart even if the page was swapped while wmux was away, and it makes a
  genuinely closed tab report as closed right away rather than after a
  five-minute grace period. Chrome builds that do not expose tab targets keep
  working exactly as before; set `WMUX_CHROME_TARGET_WATCHER=0` to opt out.

### Fixed

- Browser (`chrome` backend): a tab handle returned by `browser_open` /
  `browser_tabs new` now stays valid for the life of the tab. Chrome
  routinely replaces the target behind a tab (the first-run sync flow does
  exactly this), which used to silently invalidate the id an agent was
  holding — every follow-up tool call then failed with a target miss and the
  only recovery was opening a new tab. Handles are also remembered across a
  wmux restart, so a tab you opened before quitting is still addressable when
  wmux comes back to the same Chrome.
- Browser (`chrome` backend): `browser_close` now actually closes a Chrome
  tab. It previously reported success while doing nothing, because the close
  was routed to the app window, which knows nothing about Chrome tabs. A close
  issued from one workspace still cannot touch another workspace's tab.

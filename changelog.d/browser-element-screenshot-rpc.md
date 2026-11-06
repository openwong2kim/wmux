### Fixed

- **Element screenshots in the in-app browser work every time.**
  `browser_screenshot` with a `ref` on the built-in browser used to need the
  automation page that only sometimes attached to a tab, so the same call could
  crop the element once and then report that it could not capture the ref.
  wmux now captures the element itself, cropped to its box, so it works
  without that page. If the crop cannot be taken (the tab is hidden, or the
  element does not fit on screen while the page has stopped drawing), the call
  fails with the reason instead of returning the whole viewport.

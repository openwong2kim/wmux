### Fixed

- **File uploads in the in-app browser work every time.** `browser_file_upload`
  on the built-in browser used to need the automation page that only sometimes
  attached to a tab, so the same upload could work once and then report that no
  browser page was available. wmux now sets the files on the input itself, so
  an upload works without that page. A `ref` from either kind of snapshot still
  finds the file input next to a styled upload button. The 50MB ceiling on
  `ref` uploads is gone on this backend too, since the browser opens the file
  by path.

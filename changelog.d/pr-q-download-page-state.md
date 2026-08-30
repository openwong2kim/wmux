### Fixed

- **A download that turns into a navigation no longer strands the agent on
  another page.** Chrome ignores a link's `download` attribute across origins
  and renders the target instead, so clicking a link to a video on someone
  else's host navigates rather than downloading. `browser_download` timed out —
  correctly — but left the tab sitting on the media URL, and the next snapshot
  described a completely different page with nothing to say the original had
  gone. The tab is now put back where it was, and the error names the cause, the
  URL the browser ended up at, whether the page was recovered, and what to do
  instead. Restoring goes through history rather than a fresh load: measured on
  Chrome 141, reloading by URL leaves the stray entry in place, so a later
  `browser_navigate_back` walks straight back into the failure.

### Added

- **`browser_download` now says what it downloaded.** It returned only the saved
  path — an extension-less temp name when no `filename` was given — so the
  browser's own filename and the source URL were reachable only by driving
  `browser_click` and `browser_wait_for_download` instead. Both now come back
  from the one call, which is what a follow-up step (handing the file to
  `ffmpeg`, naming an output) actually needs.
- **`browser_download` takes a `timeout`.** It bounds the wait for the download
  to START, which is the property that lets large files work at all: a transfer
  that begins in time then runs for minutes still completes — measured, a 60s
  download succeeds under the 30s default. The default is unchanged; the
  parameter exists for pages that are slow to begin, and the description now
  says which half of the operation it covers.
- **`timeout: 0` disabled the download waits.** Playwright reads zero as "wait
  forever", so on `browser_download` it removed the very start-bound the value
  exists to impose, and on `browser_wait_for_download` it hung a call whose
  entire job is to give up. Both now require a positive whole number.

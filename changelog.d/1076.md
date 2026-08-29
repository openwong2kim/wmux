### Fixed

- **`browser_extract_text` no longer returns hidden text.** It stripped only
  `aria-hidden` elements, so anything a page hides with CSS came through as
  content — on naver.com the first several hundred characters were a hidden
  promo banner, a collapsed search-suggestion layer and a dormant error
  placeholder, while `browser_smart_snapshot` read the same page cleanly.
  Elements the browser does not render (`display:none`, `visibility:hidden`,
  or no box at all) are now skipped along with their subtrees, matching what
  the snapshot tools already saw.

- **Browser tool errors no longer lead with wmux-internal symbols.** Failures
  arrived as `mcpServer.executeToolHandler: Timeout 30000ms exceeded` and
  `automationLease: net::ERR_NAME_NOT_RESOLVED` — a module name inside wmux,
  not the tool that failed. The prefix is dropped, so the message starts with
  the part that says what went wrong.

- **The inline lifecycle-event block ends with a line break.** Without it the
  block ran straight into the tool's own output
  (`...(24s ago)Navigated to https://...`).

- **A repeated `navigated` event no longer survives self-echo suppression.**
  When a page's `loaded` event arrived in the same window as its `navigated`,
  `browser_navigate` reported the navigation twice — once in its own result and
  again in the event block. (#1072)

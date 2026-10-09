### Added

- **Browser actions wait for the page to catch up.** After a click, typing,
  a form fill, a key press or a select, the agent's next snapshot now shows
  what the action did: if the action starts network requests, wmux waits for
  them (or for the page load, when it navigated) for at most 5 seconds. An
  action that starts no request within 100 ms returns as before. Before, a
  snapshot taken right after a click that loaded data often still showed the
  old page.
- **Dialogs on the agent's own tabs are reported instead of silently closed.**
  An `alert`, `confirm` or `prompt` that an agent action opens on a tab the
  agent owns now stays open and shows up as a `[modal]` block in the tool
  result, and `browser_dialog` answers it. The action that opened it returns
  at once instead of waiting. A dialog the agent did not cause is left for the
  person at the browser. A file chooser opened by a click on the agent's tab is
  answered with `browser_file_upload`. Your own tabs, and tabs you lent to an
  agent, keep their old behaviour, and leaving a page (`beforeunload`) is still accepted
  automatically.

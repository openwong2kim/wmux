### Changed

- **A plain drag selects text in apps that use the mouse.** Codex and other terminal apps that turn on mouse tracking used to take every drag, so the only way to copy from their panes was Option+drag on macOS or Shift+drag elsewhere. Now a plain drag selects text there too, while a click still goes to the app and the wheel still scrolls it. To send a drag to the app, hold Shift (macOS) or Alt (Windows, Linux). Settings › Terminal › Input turns this off to get the old behaviour back. (#1947)

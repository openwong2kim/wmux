### Added

- **Terminal file links open in a wmux editor tab.** Clicking a file path in a terminal (plain paths, wrapped paths and OSC 8 `file:` links) now opens it in a read-only editor or preview tab of that pane, at the line when the path carries one (`src/a.ts:42:7`), instead of handing it to the system app. The target line is scrolled into view and marked. A new Settings › Terminal option, "Open file links in", switches back to the system app.
- **WSL paths in terminal links.** Paths printed inside a WSL shell, including `/home/...` paths, `file://` links and relative paths, resolve to the matching `\\wsl.localhost\<distro>` location and open in the viewer.

### Changed

- **A `:line:col` suffix on a terminal path is now underlined with the rest of the link** instead of sitting outside it.
- **Markdown files opened from a link with a line show their source**, so the line can be marked.

### Security

- **OSC 8 `file:` links never reach the system opener.** A link whose host is not this machine is refused, and a file the in-app viewer cannot show is reported as a failure rather than handed to the OS.
- **The file reader's sensitive-path blocklist now covers `\\wsl$` and `\\wsl.localhost` shares.** Credential directories inside a WSL distro are refused the same as on the host.

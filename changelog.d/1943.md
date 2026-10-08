### Changed

- **Computer use no longer asks before each app.** Once you turn computer use on, an agent can drive any app that is not blocked without a consent prompt per app. Before, every new app raised a prompt, so doing the task by hand was often faster. The prompt is still there as an option: Settings › Computer use › Ask before each app.
- **A shorter blocklist.** Agents may now drive terminals, System Settings, Xcode and other agent apps. Only password managers, wmux itself and system sign-in or administrator prompts stay blocked. Keyboard shortcuts are refused only when they lock the screen, log out or force-quit apps; app switching, Start, Spotlight and Mission Control now work.
- **Apps are brought forward automatically.** Clicking or typing into an app that is behind other windows used to fail with "window not focused"; the app now comes to the front first.
- **Clicks work on macOS 26.** On macOS 26 every click and scroll by position failed with "another window covers that point", because the Dock keeps an invisible full-screen window on top. Those clicks land again.

### Added

- **Agents can open apps.** The computer tool's new `openApp` action launches an app (by name, bundle id or path) or brings it forward, so an agent no longer depends on the app already running.
- **An agent cursor and a halo.** While an agent drives an app, a second cursor shows where it acts and a halo outlines the window it works in. Turn it off in Settings › Computer use › Show agent cursor and halo.
- **Permission buttons on macOS.** Settings › Computer use shows whether Accessibility and Screen Recording are allowed, with Request access, Reset access (for an entry that reads as on but no longer works) and Show helper in Finder. When a permission is missing, the message now names where the helper app is.

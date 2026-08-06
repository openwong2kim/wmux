### Fixed

- **Detach on an attached remote workspace now works.** Right-clicking the
  sidebar row opened its menu, but pressing "Detach" did nothing at all. The
  menu dismissed itself on `mousedown`, which arrives before `click`, so the
  button unmounted under the pointer before its own handler could ever run —
  the action was unreachable rather than broken.

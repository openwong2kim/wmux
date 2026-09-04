### Fixed

- `browser_type` and `browser_fill` now accept `smartRef` (from `browser_smart_snapshot`) as well as `ref`, the way `browser_click` already did. A smart ref passed as `ref` no longer reads as a missing element: the error names which ref space the argument was read in and which parameter the number belongs to.

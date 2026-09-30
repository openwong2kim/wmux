### Fixed

- **The sidebar git sync badge works in repos with many submodules.** Its
  `git status` scanned every submodule's working tree. In a repo with 66
  nested submodules that took 73 seconds, far past the 10-second timeout, so
  the badge never appeared and a new git process started every 15 seconds
  while the killed ones' submodule children kept running. Status now skips
  submodule working trees (227 ms in the same repo). A submodule checked out
  at a different commit still counts as a change; uncommitted edits inside a
  submodule no longer do. (#PENDING)

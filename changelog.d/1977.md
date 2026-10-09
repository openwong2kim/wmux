### Added

- **Pane names now work in channel mentions and Moa hand-offs too.** A channel post's mention can pin a pane with `#w1-2` or `#backend` instead of its pane id, and Moa can hand work to `#backend` instead of looking up the terminal id first. These were the last two places that still needed the raw id after pane names became addresses.

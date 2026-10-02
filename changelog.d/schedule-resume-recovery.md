### Fixed

- **A temporary session lookup failure no longer permanently invalidates a paused prompt schedule.** Resume keeps the schedule paused with its original binding and delivery claim intact, explains that verification is unavailable, and lets you retry. Each retry checks the session identity again; a confirmed replacement still requires recreating the schedule. Local fallback mode refuses Resume while keeping existing schedules manageable.

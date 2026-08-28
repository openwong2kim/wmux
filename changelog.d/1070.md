### Changed

- Inline browser lifecycle events are now attributed to the tool call that caused them: the lifecycle ring is drained again after each tool body, so a click that navigates (or `browser_navigate` itself, which now reports events like every other browser tool) shows the navigation on its own result instead of one call late. A lone `navigated` that merely repeats the URL the result already states is suppressed; redirect hops stay visible.

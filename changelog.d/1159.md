### Fixed

- The snapshot footer no longer calls a finished application UI a skeleton screen. The verdict now requires requests actually in flight; text density alone was calling every icon-and-nav-heavy page "still loading" — a fully rendered GitHub pull-request list measures 0.78 characters of text per element against the Node docs' 8.39, so no density threshold separates loading from app-shaped. The trade is that the builtin backend, which never tracks requests, stops producing this note at all; the "nearly empty" note, which needs no request counts, still covers a genuinely blank page.

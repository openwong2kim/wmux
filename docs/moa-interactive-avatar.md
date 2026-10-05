# Moa interactive companion (MIT)

The original lavender body, curled tuft and pink cheeks remain recognizable. New SVG geometry, round pupil eyes and pointer gaze were authored directly for wmux. The existing MoaMascot API integrates the artwork into the titlebar and panel without changing product state routing.

Only supported states are rendered: idle (blink), working (focused closed eyes and dots), needs-you (raised hand and question face), done (smile, raised hands and hearts). Small 20/28px instances retain state-specific faces but omit limbs, tuft and effects. Pointer gaze is bounded and eased; it resets on pointer leave. Both OS and Moa reduced-motion settings disable animation and gaze movement. No keyboard action is added; existing buttons retain their semantics. Optional labels expose an image; unlabeled avatars remain decorative. Body colours remain brand colours across themes, while status accents use theme tokens.

## Provenance and license

| Material | Source | License |
| --- | --- | --- |
| New SVG geometry, eye/pupil design, gaze interaction | Independently authored in MoaMascot.tsx for this task | MIT, repository LICENSE |
| Existing Moa brand palette, four-state contract, React hooks and effects | wmux origin/main 99267091 | MIT, repository LICENSE |
| Adjusted animation timing and amplitude | Existing wmux CSS plus independently authored changes | MIT, repository LICENSE |
| Preview page and tests | Independently authored for wmux | MIT, repository LICENSE |
| External avatar source, runtime, presets, character assets | None downloaded, copied, imported or bundled | Not applicable |

All new code and original SVG artwork are covered by wmux's existing MIT LICENSE (Copyright (c) 2025 openwong2kim). No external AGPL source or preset is included, and no external avatar repository was accessed. No new dependency, service, API or runtime is required.

The preview renders the actual React component and CSS, rather than a separate illustration. Listening, speaking and error states are deliberately absent because wmux's mascot state interface does not provide them. Pointer tracking is local to the SVG; it does not track the global cursor.

## Validation in this environment

- `npm ci --ignore-scripts --no-audit --no-fund`: installed the locked dependencies; no package changes.
- `npm run typecheck:quiet`: passed all 8 slices.
- Changed component and live preview ESLint: passed without errors or warnings. Existing test file has three non-null assertion warnings.
- `node scripts/verify-moa-avatar.cjs`: passed 12 state/size server renders, image semantics, compact effects, reduced-motion behavior and the 32-SVG exported preview structure. Additional real React DOM checks passed bounded pointer gaze, leave reset and reduced-motion freeze. It uses TypeScript transpilation and real React server rendering with mocked settings hooks; it is not an Electron end-to-end test.
- `git diff --check`: passed.
- After rebasing onto origin/main dea68206, Vitest mascot/titlebar/panel regressions passed: 3 files, 50 tests. The live preview esbuild bundle passed with `--external:os` (the existing shared constants reference Node os); this is not a full application build. Earlier stalled attempts were superseded by these completed checks.
- The final live React preview rendered successfully in the in-app browser. Light/dark backgrounds and all four states at 20/28/48/144px were visually inspected; screenshot: `previews/moa-avatar-preview.jpg`. Earlier navigation timeouts were superseded. Full Electron application end-to-end testing was not performed.

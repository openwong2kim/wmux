# macOS Auto-Start (Login Item) — Research

> Status: research only, no code yet. Consumed by the future
> `src/main/autostart/macos.ts` implementation in a later cross-platform
> porting batch.
>
> Author context: Outside Voice T5 raised that the wmux cross-platform
> plan calls `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`
> on macOS, but `SMLoginItemSetEnabled` was deprecated in macOS 13 (Ventura)
> in favour of `SMAppService` + an in-bundle helper. This document resolves
> that concern and recommends a path before any code lands.
>
> Date: 2026-04-28. Researcher worked from Windows; no macOS hardware
> validation was performed. Items requiring on-device validation are flagged
> in the "Open questions" section.

## Background

wmux currently depends on `electron@41.0.3` (released 2026-03-11). The
upstream cross-platform plan for macOS is to call:

```ts
app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
```

Two facts make that call non-trivial on modern macOS:

1. `SMLoginItemSetEnabled` (the framework wmux/Electron historically used
   under the hood) is deprecated as of macOS 13. Apple replaced it with
   `SMAppService`, which can either treat the **main app bundle itself** as
   the login item (`SMAppService.mainApp`) or load a nested **helper app
   bundle** at `Contents/Library/LoginItems/Helper.app/`
   (`SMAppService.loginItem(identifier:)`).
2. The `openAsHidden` boolean is explicitly documented by Electron as
   *"This does not work on macOS 13 and up."* The Electron API reference
   also notes the same for `wasOpenedAsHidden` and `restoreState`. ([Electron app docs][electron-app])

The good news is that Electron migrated `app.{set|get}LoginItemSettings`
to `SMAppService` in [PR #37244][pr-37244], merged on 2023-10-16 and
shipped in **Electron 29**. wmux is on Electron 41, so we get the modern
implementation for free — provided we accept the deprecations above and
provided the app is **signed and notarized**.

## Findings

### Electron 41 `app.setLoginItemSettings` — what it actually does on macOS

I read the current Electron source on `main` (which matches the v29+
branch behaviour) to confirm exactly which native API gets called.

In `shell/browser/browser_mac.mm`, `Browser::SetLoginItemSettings`
branches on `@available(macOS 13, *)`:

- **macOS 13+ path** calls `platform_util::SetLoginItemEnabled(type,
  service_name, open_at_login)` after migrating any old
  `LSSharedFileList` registration off the deprecated API.
- **Pre-13 path** still uses `base::mac::AddToLoginItems` /
  `RemoveFromLoginItems`, which wraps `LSSharedFileList`.

In `shell/common/platform_util_mac.mm`, the `type` string maps directly to
`SMAppService` constructors:

```objc
// Confirmed in electron/electron@main, shell/common/platform_util_mac.mm
if (type == "mainAppService")     return [SMAppService mainAppService];
else if (type == "agentService")  return [SMAppService agentServiceWithPlistName:service_name];
else if (type == "daemonService") return [SMAppService daemonServiceWithPlistName:service_name];
else if (type == "loginItemService")
  return [SMAppService loginItemServiceWithIdentifier:service_name];
```

So on Electron 41 + macOS 13+:

| Caller code | Underlying native call |
|---|---|
| `setLoginItemSettings({ openAtLogin: true })` (default `type: 'mainAppService'`) | `[[SMAppService mainAppService] registerAndReturnError:...]` |
| `setLoginItemSettings({ openAtLogin: true, type: 'loginItemService', serviceName: 'com.wmux.helper' })` | `[[SMAppService loginItemServiceWithIdentifier:@"com.wmux.helper"] register...]` |

`mainAppService` does **not** require a helper bundle — the main `.app`
itself is what gets registered. This is the central insight that changes
the cost analysis below.

Behavioural notes from issues / PRs / community:

- **Signing + notarization is effectively required.** In Electron issue
  [#45672][issue-45672], maintainers and other contributors reproduced the
  "doesn't work on macOS 15" report and concluded that the new
  `SMAppService` path silently fails for unsigned/un-notarized apps.
  Quote from the thread (nikwen, 2025-02): *"I just tested on Electron
  v34.2.0. Everything works flawlessly if the application is signed and
  notarized."* Older `LSSharedFileList`-based Electron versions (≤ 28)
  worked without signing; the new API is stricter.
- **`openAsHidden` is silently dropped.** Per Electron docs and issue
  [#37228][issue-37228], the field is preserved in object form but has no
  effect on macOS 13+. To launch hidden, the app must check at startup
  whether it was launched-at-login (e.g. via the absence of dock
  activation / inspecting `process.argv` for a launch-at-login marker)
  and call `app.dock.hide()` itself.
- **MAS parity.** PR #37244 explicitly unifies MAS and non-MAS builds on
  `SMAppService`, closing [#37560][issue-37560]. We don't ship to MAS
  today, but if we ever do, the same code path applies.

Sources: [Electron app.setLoginItemSettings docs][electron-app],
[PR #37244][pr-37244], `electron/electron` source files
`shell/browser/browser_mac.mm` and `shell/common/platform_util_mac.mm`
on `main` (read 2026-04-28 via `gh api`).

### SMAppService API — what it actually requires

There are three relevant `SMAppService` constructors. wmux only cares
about two of them (`mainAppService` and `loginItemService`); daemon /
agent are out of scope.

**`SMAppService.mainApp` (Electron `type: 'mainAppService'`)**

- **Helper bundle:** none. The main `.app` is the login item.
- **Info.plist:** no extra keys. Standard `CFBundleIdentifier`,
  `CFBundleExecutable` etc. that Electron Forge already produces.
- **Code:** Apple's recommended Swift snippet is `try
  SMAppService.mainApp.register()` / `unregister()` / read
  `SMAppService.mainApp.status`. Electron wraps all of this. ([nilcoalescing][nilcoalescing])
- **User experience on first enable:** macOS shows a system notification
  *"“wmux” Added to Login Items"* with a "Open Login Items
  Settings…" button. The user can disable it from
  System Settings → General → Login Items → "Open at Login" list (and
  also from "Allow in the Background"). If the user disables it there,
  `status` flips to `.requiresApproval` and re-registering re-prompts.
- **Signing / notarization:** required in practice (see above).
- **Availability:** macOS 13.0+. Older macOS still falls through to
  Electron's `LSSharedFileList` path.

**`SMAppService.loginItem(identifier:)` (Electron `type: 'loginItemService'`)**

- **Helper bundle:** required, **nested inside the main `.app`**:
  ```
  wmux.app/
    Contents/
      Library/
        LoginItems/
          wmux-launcher.app/        <-- nested .app
            Contents/
              Info.plist            <-- CFBundleIdentifier = "com.wmux.launcher"
              MacOS/
                wmux-launcher       <-- tiny native binary that re-launches main app
  ```
- **Identifier passed to the API is the *bundle ID* of the helper**, not
  a plist filename. This contradicts older Apple docs and is clarified by
  Apple DTS engineer Quinn in [Apple Forums thread 719862][apple-forum-719862]
  (filed as Apple radar FB11786569).
- **Helper Info.plist must include** at minimum `CFBundleIdentifier`,
  `CFBundleExecutable`, `CFBundlePackageType` (`APPL`), and almost
  always `LSUIElement = YES` (so the helper has no dock icon /
  no menu bar). ([theevilbit blog][theevilbit])
- **Code signing:** the helper must be signed with the same Team ID as
  the main app, and the helper must be notarized as part of the main
  bundle. electron-builder does not have a first-class option for nested
  `.app` bundles in `Contents/Library/LoginItems/` (the existing
  `helperBundleId` family of options refer to Chromium's GPU/Renderer
  helpers, not login-item helpers). It can be done via `extraFiles` plus
  custom `afterSign` / `afterPack` hooks, but it is non-trivial and
  unusual for the JS/Electron ecosystem. ([electron-builder mac docs][eb-mac])
- **No off-the-shelf npm wrapper.** I searched npm + GitHub for community
  modules that ship a prebuilt `SMAppService.loginItem` helper for
  Electron and found none as of 2026-04. Closest analogue is Sindre's
  Swift-only `LaunchAtLogin` (and its now-retired
  `LaunchAtLogin-Legacy`), which is not Electron-friendly. The Rust
  community has `smappservice-rs`, also not directly useful from
  Electron.

Sources: [Apple SMAppService][apple-smappservice],
[Apple `loginItem(identifier:)`][apple-loginitem],
[Apple Forums 719862 — Quinn][apple-forum-719862],
[theevilbit blog][theevilbit],
[electron-builder MacConfiguration][eb-mac].

## Options

| Option | Effort | Stability | UX | Recommendation |
|---|---|---|---|---|
| **A: `app.setLoginItemSettings({ openAtLogin: true })` as-is (default `mainAppService`)** | **Low** (already in plan) | **Future-proof** — Electron already routes through `SMAppService.mainApp` on macOS 13+. The deprecated `openAsHidden` field is silently ignored, but the actual login-item registration is on the modern API. | Same one-toggle UX as Windows/Linux. macOS shows a one-time "Added to Login Items" notification on first enable. "Launch hidden" must be implemented separately by the app (check launch reason at startup, call `app.dock.hide()`). | **Recommended for v3.x macOS GA.** |
| **B: Nested helper `.app` + `loginItemService`** | **High** (~3–5 engineering days incl. Forge build hooks, helper binary, signing wiring, on-device validation, troubleshooting first-run approval flow) | Future-proof, but adds a moving part (the helper binary) that must be kept signed/notarized in lockstep with the main app. | Slightly cleaner "background only" semantics — the helper can launch headlessly and decide whether to surface the main app. Tradeoff: extra entry in System Settings → Login Items. | Not recommended unless we discover a concrete gap with Option A (e.g. main-app launch is too slow to be a login item, or user complaints about the dock-flash on startup). Revisit only if needed. |
| **C: Skip auto-start on macOS at first ship; document manual instructions** | **None** | N/A | Worse than Win/Linux parity; users have to add wmux to Login Items themselves via System Settings. | Acceptable interim if signing+notarization isn't ready by ship-day; otherwise inferior to A. |

### Why not Option B

The "wmux plan needs a helper bundle" framing in T5's outside voice is
based on the older `SMLoginItemSetEnabled` model where a helper was
mandatory. Under modern `SMAppService`, the helper is one of two
available shapes, not the only shape — and `mainApp` (which Electron
calls by default) does not need one. The cost of B is real (Forge build
pipeline changes, native helper binary, signing wiring, additional
notarization surface, additional approval prompt to explain to users)
and the benefit is small for a tray-resident app like wmux.

## Recommended Path

**Adopt Option A.** Concrete work items to add to the next porting batch:

1. **`src/main/autostart/macos.ts`** — call
   `app.setLoginItemSettings({ openAtLogin: enabled })` (omit
   `openAsHidden` entirely on macOS to avoid passing a no-op flag; do
   not pass `type` so we get the default `mainAppService`). Read state
   back via `app.getLoginItemSettings().openAtLogin`. Treat
   `status === 'requires-approval'` as "user disabled it in System
   Settings — show a one-line hint linking to System Settings if they
   re-enable from inside wmux."
2. **Launch-hidden replacement** — at startup, if the process was
   launched as a login item (Electron exposes
   `app.getLoginItemSettings().wasOpenedAtLogin`, but that field is
   *also* deprecated on macOS 13+; safer to detect via
   `process.argv.includes('--hidden')` passed by the autostart wiring or
   via `app.dock.isVisible()` heuristic), call `app.dock.hide()` before
   the first window opens. Validate on hardware before claiming parity.
3. **Signing + notarization gate in CI** — the macOS auto-start feature
   silently fails for unsigned/un-notarized builds. Add a release
   checklist item: "`pnpm dist:mac` artifact must pass `spctl
   --assess` and `stapler validate` before publishing." Tracking issue
   pre-condition for the macOS port shipping.
4. **First-run approval UX** — after the first time wmux calls
   `setLoginItemSettings({ openAtLogin: true })`, macOS shows its own
   notification. We do not need to ship an in-app modal, but the
   Settings → Startup screen should display the live status returned by
   `getLoginItemSettings()` so the user can see if they later disabled
   it from System Settings.
5. **Docs** — add to user-facing release notes: *"On macOS, enabling
   Launch at Login adds wmux to System Settings → General → Login Items.
   You can disable it there at any time."*

Defer Option B unless on-device testing surfaces a concrete blocker that
`mainAppService` cannot solve.

## Open questions (require macOS hardware to settle)

- **Notarized launch-hidden behaviour.** Confirm that, with no window
  shown and `app.dock.hide()` called early, wmux launches into the tray
  silently with no dock flash on macOS 14 and 15.
- **`wasOpenedAtLogin` reliability on Electron 41.** Apple removed the
  underlying signal in macOS 13. Test whether Electron still fills this
  field for default `mainAppService` registrations, or whether we need
  an explicit `--hidden` arg passed by something we control.
- **Migration from old API.** Any pre-v3 macOS install that registered
  via the legacy API will be migrated by Electron's `RemoveFromLoginItems`
  call before re-registering on the new one. Verify that this round-trip
  doesn't trigger a duplicate "Added to Login Items" notification.
- **Apple-Silicon first-run delay.** Some community reports note a 1–2 s
  initialisation delay on the first SMAppService registration. Worth
  confirming with QA that this doesn't visibly stall the Settings
  toggle.

## References

- [Electron — `app.setLoginItemSettings` API docs][electron-app] — primary doc, lists the new `type` / `serviceName` params and the `openAsHidden` deprecation.
- [Electron PR #37244 — feat: update `app.{set|get}LoginItemSettings`][pr-37244] — the migration PR (merged 2023-10-16, shipped in Electron 29). Wmux is on Electron 41 ⇒ we get this for free.
- `electron/electron` source on `main` — `shell/browser/browser_mac.mm` (`Browser::SetLoginItemSettings`) and `shell/common/platform_util_mac.mm` (`GetServiceForType`, `SetLoginItemEnabled`). Read via `gh api ... .raw` on 2026-04-28.
- [Electron issue #45672 — setLoginItemSettings openAtLogin not working on macOS][issue-45672] — confirms the new path requires signing + notarization (resolved as "WAI, app must be signed").
- [Electron issue #37228 — `openAsHidden` not respected on Ventura][issue-37228] — closed as not planned; the field is intentionally a no-op on macOS 13+.
- [Electron issue #37560 — MAS build][issue-37560] — closed by PR #37244, MAS now uses the same SMAppService path.
- [Apple — `SMAppService` class reference][apple-smappservice]
- [Apple — `SMAppService.loginItem(identifier:)`][apple-loginitem]
- [Apple Developer Forums #719862 — Quinn on registering login items][apple-forum-719862] — clarifies that the parameter is the helper *bundle ID*, helper lives at `Caller.app/Contents/Library/LoginItems/Helper.app/`, and `.notFound` is the normal first-time status.
- [theevilbit — macOS Service Management quick notes][theevilbit] — practical walkthrough of `SMAppService` registration, status flow, and approval requirement.
- [Costello — Add launch at login setting to a macOS app][nilcoalescing] — minimal `SMAppService.mainApp` Swift example; corroborates that no helper bundle is needed for `mainApp`.
- [electron-builder — Mac configuration][eb-mac] — confirms there is no first-class option for `Contents/Library/LoginItems/*.app` nested helper bundles; Option B would need custom `afterPack` hooks.

[electron-app]: https://www.electronjs.org/docs/latest/api/app
[pr-37244]: https://github.com/electron/electron/pull/37244
[issue-45672]: https://github.com/electron/electron/issues/45672
[issue-37228]: https://github.com/electron/electron/issues/37228
[issue-37560]: https://github.com/electron/electron/issues/37560
[apple-smappservice]: https://developer.apple.com/documentation/servicemanagement/smappservice
[apple-loginitem]: https://developer.apple.com/documentation/servicemanagement/smappservice/loginitem(identifier:)
[apple-forum-719862]: https://developer.apple.com/forums/thread/719862
[theevilbit]: https://theevilbit.github.io/posts/smappservice/
[nilcoalescing]: https://nilcoalescing.com/blog/LaunchAtLoginSetting/
[eb-mac]: https://www.electron.build/mac.html

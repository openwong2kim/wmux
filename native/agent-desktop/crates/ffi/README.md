# agent-desktop-ffi

A C-ABI library over the [`PlatformAdapter`](../../crates/core/src/adapter/mod.rs) trait. It builds a shared library for C, C++, Python (ctypes), Swift, Go (cgo) and Node (ffi-napi). Calls run in process, so a program does not start the CLI for each command.

The full guide is at https://agent-browser.dev/desktop/ffi. It covers linking, the API, ownership and threading. The agent-facing version is the [`agent-desktop-ffi` skill](../../skills/agent-desktop-ffi/SKILL.md).

## Build

```bash
cargo build --profile release-ffi -p agent-desktop-ffi
```

The output is in `target/release-ffi/`: `libagent_desktop_ffi.dylib` on macOS, `libagent_desktop_ffi.so` on Linux, and `agent_desktop_ffi.dll` on Windows.

Use `--profile release-ffi`, not `--release`. The `release` profile sets `panic = "abort"`, which turns off the `catch_unwind` traps at the `extern "C"` boundary without any error. The `release-ffi` profile keeps `panic = "unwind"`.

A source build also needs the platform helper beside the library: `agent-desktop-macos-helper` on macOS, `agent-desktop-linux-clipboard-owner` on Linux.

For CI and tests that need no accessibility permission, build the stub adapter. It returns `PLATFORM_NOT_SUPPORTED` for every adapter call.

```bash
cargo build --profile release-ffi -p agent-desktop-ffi --features stub-adapter
```

`--features stub-adapter` replaces the real platform adapter with a no-op that
returns `PLATFORM_NOT_SUPPORTED` for every adapter call.

## ABI Surface

| Group | Key symbols |
|-------|-------------|
| ABI handshake | `ad_abi_version()`, `ad_init(expected_major)` |
| Adapter lifecycle | `ad_adapter_create()`, `ad_adapter_create_with_session(id)`, `ad_adapter_destroy()` |
| Command-backed JSON entrypoints | `ad_snapshot`, `ad_execute_by_ref`, `ad_execute_by_ref_timeout`, `ad_wait`, `ad_version`, `ad_status`, `ad_trace_show`, `ad_trace_export` |
| Log callback | `ad_set_log_callback(fn(level, msg))` — unstructured tracing to a callback |
| Structured file trace | Same JSONL contract as CLI, gated by a `trace: on` session manifest (no ABI change); use `session start` before creating a session adapter |
| Errno last-error | `ad_last_error_code()`, `ad_last_error_message()`, `ad_last_error_suggestion()`, `ad_last_error_platform_detail()` |
| Type accessors / size getters | `ad_*_size()`, `ad_*_list_{count,get,free}()`, `ad_image_buffer_*()` |
| Free helpers | `ad_free_string()`, `ad_free_handle()`, `ad_free_tree()`, `ad_free_action_result()` |

The full declaration list is in [`include/agent_desktop.h`](include/agent_desktop.h).
Consumers must call `ad_init(AD_ABI_VERSION_MAJOR)` after `dlopen` to verify the
loaded dylib matches the header the consumer was built against.

Direct window, surface and ref targeting takes the versioned
`AdExactRefEntry`, `AdExactWindowInfo`, and `AdExactSurfaceInfo` structs, which
carry the process generation and surface ID of the observed identity.
ABI 6 and `AD_EXACT_REF_ENTRY_VERSION` 2 add `bounds_space` to `AdRefGeometry`,
inside `AdExactRefEntry`: an `AD_BOUNDS_SPACE_*` constant naming the frame of
`bounds`, screen-relative on macOS and Windows and window-relative on Linux.

ABI 7 makes the two exact-entry ref calls,
`ad_execute_ref_action_exact_with_policy` and `ad_resolve_element_exact`, fail
closed with `AD_RESULT_ERR_ACTION_NOT_SUPPORTED`: an exact entry carries no retained
element token and no capture proof, so it cannot be re-identified. Act through
a snapshot ref with `ad_execute_by_ref`, and get a handle with `ad_find_exact`.
`ad_execute_by_ref` and `ad_wait` accept only snapshot-qualified refs
(`@<snapshot_id>:eN`).

## Command wrappers

Each command-backed JSON entrypoint has one canonical module under
`src/commands/`. The build script only configures the dylib install name and
never rewrites source files.

## Thread Safety (macOS)

Adapter entrypoints may run on any host thread. AX and CG calls have no blanket
main-thread restriction, and Apple explicitly documents
[`NSWorkspace.shared`](https://developer.apple.com/documentation/appkit/nsworkspace/shared)
as safe from any thread. Cocoa-backed paths establish per-thread autorelease
pools; FFI initialization starts one `NSThread` once so Cocoa enables the locks
Apple documents for POSIX-threaded hosts.

Native handles are stricter: resolve, use, and free each handle on the same
thread with the same adapter. Mutations are serialized across processes by the
canonical interaction lease. See the FFI skill's threading reference for the
full evidence and ordering contract.

## Error Model

Every `AdResult`-returning function sets thread-local last-error state on failure.
Read it with `ad_last_error_code()` / `ad_last_error_message()` /
`ad_last_error_suggestion()`. The pointer returned by `ad_last_error_message()`
stays valid until the next *failing* call on the same thread — successful calls
leave it untouched (POSIX errno semantics).

## Full Documentation

`skills/agent-desktop-ffi/` — build-and-link guide, ownership model, threading
rules, and error-handling patterns.

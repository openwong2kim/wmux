# UI plugin rail pages and agent state

The following additions extend plugin bridge v1. Existing manifest fields and
request/response envelopes keep their meanings. New plugins require a host
that recognizes the new capabilities; older hosts reject their manifests.

## Page contribution

`contributes.railPage` accepts `{title, entry, agentStateEvents?}`. Title is
bounded to 64 characters and entry is a safe bundle-relative path of at most
256 characters. `ui.rail-page` must be declared and approved. The host mounts
the sandboxed iframe only while selected. `agentStateEvents:true` additionally
requires `agent.state.read`. No same-origin, navigation or filesystem privilege
is added to the iframe. Plugin routes are transient, not saved to sessions.

## Snapshot read

`agent.state({workspaceId?, includeActivity?})` is an experimental hosted-UI
plugin RPC, not an external pipe/MCP API. The host supplies the actual workspace;
a caller cannot select another workspace by changing params. Unbound callers
and external transports are refused. `agent.state.read` is required even in
shadow enforcement mode. With `includeActivity:true`, unrestricted
`terminal.read` is also required; scoped terminal grants do not authorize a
whole workspace's activities. Both grants are checked again after the read.

Response: `{workspaceId, panes, truncated}`. Each pane has `paneId`, `label`,
`state` (`working`, `needsYou`, `finished`, `resting`), `stashed`, and `surfaces`
containing `{surfaceId, agentName}`. Optional `activity` requires the additional
permission above. Labels come from user labels/coordinates, not terminal titles.
User labels can themselves contain sensitive information. Activity can contain
commands, filenames and search text; it is not included in base snapshots.

Membership comes from the canonical local agent roster. State comes from the
final Fleet board, including hook-running, pending-question and unverifiable
classification. Plain shells, Bots workspaces and all panes containing remote
terminals are excluded. Responses are bounded to 512 panes, 32 surfaces per
pane, 512 Unicode characters per display string and 1 MiB total. Omission due
to those limits sets `truncated:true`.

## Every workspace

`agent.state.all()` is the same projection for every local workspace. It
requires its own grant, `agent.state.read.all`, which a plugin declares in
addition to `agent.state.read`; approving `agent.state.read` alone never widens
to other workspaces, and the approval prompt lists the new grant as its own
row. The grant takes no path glob, is required even in shadow enforcement mode,
and is checked on every read and again after it, so a revoked or denied plugin
gets nothing more from the next read. Only a bound hosted UI plugin may call
it, and it takes no params (`includeActivity` is refused: activity is never
part of it).

Response: `{workspaces, truncated}`. Each workspace is `{workspaceId, name,
panes, truncated}`, in sidebar order, with panes exactly as in a single
snapshot. `name` is the workspace's display name, clipped like every other
string. Every local workspace is listed, including one with no agents; Bots
workspaces and remote PCs are not. A workspace created or closed after the page
opened is in, or out of, the next read. Responses are bounded to 128
workspaces and 1 MiB in total; omitting whole workspaces sets the top-level
`truncated`, omitting panes sets that workspace's.

With this grant and `pane.read`, `pane.focus({id})` from the plugin's rail page
may name a pane in any local workspace the response lists: the host switches to
that workspace and focuses the pane. The same call from the plugin's sidebar
panel or status-bar widget, which stay mounted while the user is elsewhere,
stays confined to the bound workspace. Close, stash and unstash stay confined
to the bound workspace.

## Snapshot events

The opted-in rail frame receives an immediate read, then reads at most once
per second with one request in flight. Only changed snapshots are emitted:

```
{v:1, id:null, kind:"agent-state", epoch, revision, workspaceId,
 status:"ready", snapshot}
```

A page whose plugin declares an approved `agent.state.read.all` receives
`allWorkspaces` (the `agent.state.all` response) instead of `snapshot`, and
`workspaceId` is the workspace the host is showing. That stream reads
`agent.state.all` and does not restart on a workspace switch; a switch alone
emits a new revision with the new `workspaceId`.

`reset` and `unavailable` statuses carry no snapshot. Consumers must discard
old data on either. Epoch changes with the port or workspace; revision is
monotonic only within that epoch. This is replacement state, not an EventBus
stream: it has no daemon sequence, history or replay. Events never include
activity. Every read runs through the permission gate. The loop stops on a
non-retryable refusal/error; reopening the page retries. A retryable startup
failure clears the view with `reset` and retries after one second. Explicit
read failures include `error.retryable:true` in the bridge response when safe
to retry. Page exit and reload close the old
port and timer. A workspace change invalidates pending explicit reads too.

## Navigation and installation

Plugin frames stay on their own bundle. Each document receives a fresh bridge
port, including after an internal page navigation. The host dispatches the v1
`{v:1, kind:"init"}` message with `source === window.parent` and the port in
`event.ports[0]`. This initialization event is synthetic; do not require
`event.isTrusted`. If a page cannot initialize, reopen it to retry.

`pane.focus({id})` uses its existing `pane.read` gate and workspace confinement
(widened by `agent.state.read.all` as described above).
After a successful focus from the current rail page, the host returns to
Workspaces. Responses from an earlier page/workspace lifetime do not navigate.
The example performs this on a button click; approved plugin code can initiate
focus calls, so this is not a claim of user-gesture attestation.

Settings > Plugins combines saved connectors and UI plugin pages, with Installed
and Discover views. The curated UI catalog installs the original Agent status
example from the application bundle; it does not download arbitrary URLs or
accept public submissions. Installation keeps permissions unapproved until the
owner reviews the existing permission prompt. The bundled example carries its
MIT license and publisher metadata. At startup, a catalog-installed copy whose
manifest version is older than the one the application ships is replaced by the
shipped bundle; if the new version declares more permissions than were
approved, the plugin asks for approval again. Manually installed bundles are
never replaced. The old copy is removed only once the new one is in place, and
an update interrupted between the two is rolled back at the next start.

Disabling a UI plugin stops new bridge requests, file serving and mounted pages
without restarting. Re-enabling preserves its reviewed permissions. Uninstall
is available for catalog-installed copies only and requires confirmation; a
reinstall requires approval again. Manually installed bundles can be disabled
here but their files remain under the user's control. This does not undo actions
already dispatched before a plugin was disabled.

See the original example at
[`examples/plugins/agent-state-page`](../../examples/plugins/agent-state-page).

## Theme tokens

After bridge initialization and when the host root theme attributes change,
frames receive `{v:1, kind:"theme", variables, colorScheme}` on their port.
`variables` maps CSS custom property names to computed values for page surfaces,
text, accent/state colors, selection and the UI font.
Apply these values to the frame root; keep system color fallbacks until the
first message. The sandbox prevents reading the parent document directly.

## Handing a key back

A page with keyboard focus holds every key: the app's own shortcut listener
never sees a key pressed inside the frame, so the page's toggle shortcut
(Settings › Keyboard, "Toggle <page>") could open the page but not close it.
A page may post a chord it does not use to the host:

`{v:1, kind:"key", key, code, ctrlKey, metaKey, altKey, shiftKey, repeat}`

The host runs it only when it resolves to a plugin page shortcut: it opens
that page, or returns to Workspaces when that page is the one showing, as the
key would outside the frame. Any other shortcut is ignored, so a page cannot
trigger other app actions this way. Auto-repeats are ignored. Sidebar and
status-bar frames have no page and are ignored too.

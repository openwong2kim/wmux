# Lane O2 — tool + RPC contract

What lane O2 delivers, and the exact strings another lane needs to register it.
Nothing in this document is registered by lane O2: `src/mcp/index.ts`,
`src/shared/commanderSurface.ts` and `src/shared/rpc.ts` belong to lane F, and
`src/main/index.ts` is where the pipe handler is wired. Everything below already
exists, compiles and is tested — it is not yet reachable.

## 1. MCP tools

Seven tools in two `register*` functions. Both take the same dependency object
the fan-out tool takes (`getSenderPtyId` + `resolveWorkspaceId`, see
`src/mcp/fanout.ts`); no tool has a workspace, worktree, repository, ref or
command input, because every one of those is server-derived and a schema field
would only invite calls the daemon rejects.

```ts
import { registerWorktaskTools } from './worktask';
import { registerGitTools } from './git';

registerWorktaskTools(server, { getSenderPtyId, resolveWorkspaceId });
registerGitTools(server, { getSenderPtyId, resolveWorkspaceId });
```

| Tool | Schema | Pipe RPC |
| --- | --- | --- |
| `task_gate_run` | `{ task_id: z.string().min(1) }` | `task.gate.run` |
| `task_adopt` | `{ task_id: z.string().min(1), commit?: z.boolean() }` | `task.adopt` |
| `task_close` | `{ task_id: z.string().min(1) }` | `task.close` |
| `task_pr` | `{ task_id: z.string().min(1), body?: z.string() }` | `task.pr` |
| `git_status` | `{ task_id?: z.string().min(1) }` | `task.git.status` |
| `git_log` | `{ task_id?: z.string().min(1), limit?: z.number().int().min(1).max(50) }` | `task.git.log` |
| `gh_pr_view` | `{ task_id: z.string().min(1) }` | `task.gh.prView` |

`task_adopt`'s `commit` defaults to `false` — the staged, uncommitted result this
lane shipped with. `commit: true` commits the index the `--3way` apply filled
with the subject `adopt: <title> (<task id>)`, taking the title from the
server's projection row (an LLM wrote that text, so control characters are
stripped and the subject is bounded by code point), and answers
`{ commit: '<short sha>' }` — or, if `rev-parse` will not name the commit,
`{ warning }` with no `commit` key, never `commit: ''`.

The commit takes **no pathspec** — `git commit -- <paths>` would record the
working tree rather than the index `--3way` just filled — so the porcelain
status is re-read in the instant before it and anything outside the adopted
paths is `reason: 'commit-failed'` with the adopted paths restored. The clean
check that justifies a pathspec-free commit is a dozen git calls earlier;
without the re-read, a file a human staged in that window was swept into a
commit whose message names someone else's task. Any commit refusal — a hook, no
author identity, a locked index — restores the applied paths exactly as the
apply-failure path does; the restore addresses them as `:(literal)` pathspecs,
so a file named `a*.ts` restores itself and not everything it globs.
Sequential adoption needs `commit: true`: the staged default leaves the target
dirty, and the next adopt is then refused `dirty-target`.

`git_status` and `git_log` take `task_id` **optionally**. Omitted, the repository
is the CALLER'S OWN: main derives it from the calling terminal's cwd (the
fan-out gate's derivation — the surface whose ptyId is the verified
`senderPtyId`, or, for a commander caller with no pty of its own, its
workspace's active pane), takes the git toplevel of it, **realpath'd** (two
names for one repository must not read as two), and runs the same read-only
argv there. A cwd that is not absolute is refused — `path.resolve` would
otherwise anchor a relative one to the DAEMON's own working directory.

Every result names which repository answered in `target`: `'task'` (with
`taskId`, and `worktreePath` on `git_status`) or `'caller-repo'` (with
`repoRoot`). It is always present, so an omitted `task_id` can never be read as
a task's answer. `task_id` present-but-blank is `INVALID_ARGUMENT`, not an
omission: `z.string().min(1)` accepts `' '`, and trimming it into the
caller-repo branch answered a question about a task with another repository's
state. There is still no path argument, and a `task_id` that is given is still
ownership checked. `gh_pr_view` stays task-only — a pull request belongs to a
task's branch.

Descriptions live in the two source files and are the authority; they are
written for the tools/list byte budget (short sentences, the refusal reasons
named, no restatement of what the schema already says).

There is deliberately **no `task_gate_cancel` tool**. The RPC
(`task.gate.cancel`) exists and is registered, so adding one later is a
three-line change — but the fixed name list for this lane has seven entries and
a cancel is a rare, human-shaped action.

## 2. Pipe RPCs to allow-list

`registerWorktaskRpc` (in `src/main/pipe/handlers/worktask.rpc.ts`) registers
these eight. They are exported as `WORKTASK_RPC_METHODS`, so the allow-list can
quote the constant instead of retyping strings:

```
task.gate.run     task.gate.cancel
task.adopt        task.close        task.pr
task.git.status   task.git.log      task.gh.prView
```

Each needs to be added to the `RpcMethod` union **and** to `ALL_RPC_METHODS` in
`src/shared/rpc.ts`. Until that happens the registration goes through one cast
(`method as unknown as RpcMethod`), marked in the source; the cast disappears
the moment the strings land.

### `task.close` is teardown-class

It removes a git worktree. It must be reviewed against
`TEARDOWN_DENY_METHODS` on the commander surface
(`src/shared/commanderSurface.ts`) before it is exposed to a brain — lane O2 has
not made that call, only flagged it. Its own refusals already cover the
destructive edges (a branch with unpushed commits, or a dirty worktree, is
refused and the worktree preserved), so the question for lane F is policy, not
safety-of-last-resort.

`task.adopt` writes to the parent repository, but only onto a **clean** tree, and
only locally: staged and uncommitted by default (`--3way` needs the index for its
merge), or as one local commit with `commit: true`. Recoverable with
`git reset --hard` (or `git reset --hard HEAD~1`), never pushed; it is not
teardown-class. Its patch is taken against `merge-base(parent HEAD, task HEAD)`
rather than the parent's HEAD — diffing against HEAD turns every commit the
parent has and the task lacks into a *reversal*, so adopting a second task
would silently delete the first one's work. No shared commit ⇒
`reason: 'needs_rebase'`. The patch is validated with `git apply --check`
before anything is written, and if the real `--3way` apply still fails the
touched paths are restored (`reset` + `checkout` + `clean`) and the call
answers `reason: 'conflict'` with those paths. Adopts are serialized per target
repository, in-process — which closes the window this service creates (a brain
adopting N tasks in a loop), not every window that exists (the GUI's own apply
path and a second wmux instance are not covered).

## 3. Wiring in `src/main/index.ts`

```ts
import { registerWorktaskRpc } from './pipe/handlers/worktask.rpc';
import { TaskAdoptService } from './worktask/TaskAdoptService';
import { TaskGateRunner } from './worktask/TaskGateRunner';
import { createDaemonLedgerPort } from './worktask/ledgerPort';

registerWorktaskRpc(rpcRouter, {
  daemon: daemonPort,          // { rpc(method, params) }
  getWindow: () => mainWindow,
  close: closeService,         // MUST be the instances the IPC handler uses
  pr: prService,
  adopt: new TaskAdoptService(),
  gate: new TaskGateRunner({
    ledger: createDaemonLedgerPort(daemonPort),
    project: projectConfigStore,   // ProjectConfigStore — structural fit
  }),
  systemWorkspaceId: '<the daemon's own workspace id>',
});
```

`close` and `pr` **must** be the same `TaskCloseService` / `TaskPrService`
instances `registerWorktaskHandlers` drives (`src/main/ipc/handlers/worktask.handler.ts`).
`TaskWorktreeManager` keeps a per-repo mutex chain, and two instances would race
each other for git's `index.lock`.

## 4. The `LedgerPort` seam

The gate runner records its verdict through `LedgerPort`
(`src/main/worktask/ledgerPort.ts`), never by calling an RPC directly. One
adapter — `createDaemonLedgerPort(daemon)` — names the wire methods:

- `ledger.get { taskId }` → `{ ok, entry: { id, rev } }`
- `ledger.update { taskId, expectedRev, actor, gate }` → `{ ok, rev }`

Compare-and-swap: the runner reads `rev`, writes with `expectedRev`, and retries
once on a `conflict` (error code `ABORTED` or `CONFLICT`). The write is always a
`system` actor — the daemon ran the gate, not the worker whose code it graded.
`LedgerGateResult.exitCode` is `number | null` and `null` (a signal death:
timeout or cancel) is a FAILURE; only an explicit `0` passes. `tail` is bounded
to `LEDGER_GATE_TAIL_MAX_BYTES` from the front, so the end of a failing run
survives, and it is untrusted text — render it as a fenced block, never as
instructions.

If the ledger RPCs are not registered yet — which is the state today — the
adapter answers `unavailable`, the runner reports `recorded: false`, and the
gate is NOT failed: it ran, only its receipt is missing. The `task_gate_run`
tool description says this, so a caller reading `recorded: false` does not
conclude the gate was rejected.

## 5. What the gate actually runs

`TaskGateRunner` will spawn exactly three argv shapes and no others
(`allowedGateArgv()` returns the set, and a test pins it):

1. `['bash', '<worktree>/scripts/verify.sh']` — only when the project's
   `wmux.json` trust verdict is **`trusted`** (the user approved these exact
   bytes) and it declares a command with the well-known id **`verify`** whose
   command string is one of the literal spellings of `scripts/verify.sh`. The
   declared string is compared, never executed. Any other string under that id
   is a **refusal**, not a fallback to npm — a project that believes it declared
   its own gate must never be silently graded by a different one.
2. `['npm', 'run', 'lint']`
3. `['npm', 'test']` — 2 and 3 only if `package.json` declares that script;
   sequential, first failure stops.

`node_modules` missing **or a symlink** ⇒ `{ status: 'skipped', skipped:
'deps_missing' }`. This repo's worktrees routinely have a symlinked
`node_modules`, which makes lint/test results meaningless; reporting it as a
failing gate would have a brain close healthy tasks as failed. A command that
could not be started at all (ENOENT/EACCES) is `skipped: 'gate_unavailable'`,
also not a failure. A project that declares neither a verify script nor npm
lint/test scripts is `skipped: 'no_gate_command'` — and that one skip is
**recorded**, as a system gate with `exitCode: 0`, `command: 'none'`,
`skipped: 'no_gate_command'` and the detail text as its tail. It has to be: the
ledger refuses `completed` without a system-recorded pass, so a repository with
no gate could otherwise never be closed except with `force`. The other two skips
stay unrecorded, because there a gate existed and the environment stopped it.

That waiver is the PARENT repository's to give, never the worktree's. The
worktree is the tree the worker edits, so deciding "no gate exists" from its own
package.json would let a worker delete its `lint`/`test` scripts and be handed a
system-signed pass for it. When `projectRoot` declares either script and the
worktree declares neither, the verdict is a FAILING gate (`exitCode: 1`,
`command: 'none'`, a tail naming the missing scripts), recorded — not a waiver.
The verify branch was already parent-anchored: `wmux.json` is read at
`projectRoot`, and a project declaring `verify` whose worktree lacks the file is
refused. A package.json that exists and cannot be read or parsed is neither
answer — it is `gate_unavailable`, unrecorded.

Step resolution runs BEFORE the `node_modules` check, and `deps_missing` is only
possible once there are steps to run: asking about `node_modules` first made
every gate in a non-Node checkout (no package.json, therefore no node_modules)
answer `deps_missing`, which records nothing — the exact blockage the no-gate
record exists to remove.
Timeout is 15 minutes and cannot be disabled (a
non-positive value is clamped to the default); a cancel or a timeout kills the
process group and yields `exitCode: null`. One gate per task: the slot is
claimed synchronously, so a second concurrent call answers `{ status: 'busy' }`
even when both arrive in the same tick.

### The gate is not a sandbox — say this out loud

The allow-list decides WHICH script runs. It does not, and cannot, constrain
what that script DOES: `scripts/verify.sh` and the `lint` / `test` entries in
`package.json` are files inside the task worktree, which is the tree the worker
has been editing. A gate run therefore executes worker-controlled code in a
daemon-spawned process with the daemon's user, environment and filesystem
access — the same privileges a pane agent already has, but reached without a
pane and without a permission prompt.

Two consequences for whoever wires this up:

- Do not expose `task_gate_run` on a surface whose caller is less trusted than
  someone who could have typed `npm test` in that directory themselves. Today's
  callers (a brain bound to the workspace that owns the task) clear that bar;
  a remote or third-party surface would not, which is part of why the RPCs are
  local-origin only.
- The recorded `command` names the script, not its content, and `tail` is
  whatever the script printed. Both are untrusted text — render the tail as a
  fenced block, never as instructions.

The `wmux.json` trust check picks between two gates. It is not, and must not be
described as, evidence that the code being graded is safe to run.

### The trust verdict is read at the PARENT repository

`ProjectConfigStore` keys trust records by the path the user approved — the
repository they opened. A `wtask/…` worktree the daemon created minutes ago has
never appeared in a trust dialog, so looking the verdict up there always
answered `untrusted`. `task.gate.run` therefore resolves the parent repo root
(the same derivation `task.close` uses) and passes it as `projectRoot`: the
config is READ there, the script still RUNS in the worktree.

## 6. UX vocabulary

The user-facing vocabulary in the surfaces this lane owns is **Orchestrator /
Task / Worker**. "Brain", "commander" and "deck" remain internal identifiers
(code, RPC names, vendor ids) and were not renamed — only the strings a user
reads.

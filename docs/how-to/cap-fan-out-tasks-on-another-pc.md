# Cap fan-out tasks that run on another PC

`fanout_start` with `pc` (or `pc: "any"`) runs its tasks on a paired PC — a
headless box, say — instead of in worktrees here
([Fan-out to a paired PC](../a2a-remote.md#fan-out-to-a-paired-pc)).

## The live fan-out task limit does not count them

**Settings › Live fan-out task limit** counts tasks that run on this PC. A
fan-out to another PC starts nothing here, so it is not counted against that
limit and is never refused by it. Two of this PC's settings still apply to
it: the fan-out approval switch, and the **Hourly fan-out task limit** (each
task counts once, when it is first asked for).

## Cap them on the PC that runs them

The PC that runs the tasks sets its own limits. Each one applies to every
request it gets from another PC, a fan-out or not:

| Limit | What it caps |
| --- | --- |
| Running agents per PC | Agents one asking PC may have running there at once |
| Running agents, all PCs | Agents all asking PCs together may have running there at once |
| Starts per PC per hour | Agents one asking PC may start there in any rolling hour |
| Starts per PC per day | Agents one asking PC may start there in any rolling day |

They are part of that PC's remote spawn policy, under **Settings › LAN ›
Starting agents from other PCs**. A headless box keeps the policy it was given,
but `wmux remote allow` does not set these limits yet. To cap a box, set them
in the app on that box before you turn headless mode on. An empty limit means
no limit.

A request that would go past one of them is answered as full
(`rate-limited`). For `pc: "<name>"` the task's row records the refusal. For
`pc: "any"` the task is held and goes to a PC with room the next time you
send the same call.

# Cross-PC A2A (experimental)

> **Goal:** let an agent in a pane on one of your PCs hand work to an agent in
> a pane on another of your PCs on the same LAN, and get the reply back.

Cross-PC A2A connects wmux on two PCs you own, pane to pane. An agent on PC A
sends a task to a linked pane on PC B with `send_message`; B's agent sees it
like any other A2A task, and its reply comes back to the pane on A that sent
it. Both directions work over one connection. Two PCs can also link their
Moa, so Moa on one PC can hand work to Moa on the other.

It is **experimental** and **off by default**. Nothing listens and nothing is
visible to another PC until you turn it on, pair, choose what to show, and
accept a link.

This is not LanLink. LanLink (Settings > LAN > LanLink) lets agents on other
machines post read-only messages to this one. Cross-PC A2A is a separate
feature with its own listener, its own credentials and its own settings
section; turning one on does not turn on the other.

## How it works

- **Its own HTTPS listener.** When you turn the feature on, wmux creates a
  self-signed certificate for this PC and serves a small HTTPS listener that
  answers `/api/a2a/*` and nothing else. It is not the phone web server
  (`wmux web`), and it never issues phone or device tokens.
- **Certificate pinning.** An invite carries the SHA-256 fingerprint of that
  certificate. The other PC checks it before it sends a single byte of the
  pairing code or, later, of its credential. A PC that answers with another
  certificate gets nothing.
- **One invite pairs two PCs.** The PC that creates the invite is the
  *server*; the PC that pastes it is the *joiner*. Only the server needs an
  open inbound port. The joiner connects out, sends its messages over that
  connection, and holds a stream open for messages coming back.
- **Nothing is shown by default.** For each paired PC you choose which
  workspaces and panes, and whether this PC's Moa, it may see. A pane you did
  not choose is invisible to that PC: no name, no path, no sign that it
  exists.
- **Links are made by people.** A link joins one pane on each PC, or the Moa
  of each PC. Someone on the joiner proposes it, and someone on the server
  accepts it. Agents cannot create links. A pane links only with a pane, and
  Moa only with Moa.
- **Messages only.** A task from another PC is delivered as a message to the
  linked pane, through the same approval and hold checks as a local A2A
  task. It never starts a worker or opens a pane on the receiving PC.
- **Nothing is lost while a PC is away.** Messages wait in a queue on disk
  until the other PC confirms them, and are delivered once.

## Setup

You need wmux running (with its daemon) on both PCs. In the steps below, PC B
is the one that will accept connections, and PC A is the one that joins it.

1. **Turn it on (PC B).** Open Settings > LAN > **Cross-PC A2A
   (experimental)** and turn on **Accept connections from other PCs**. The
   section shows "Listening on port 45660." when it is up. On Windows, allow
   the firewall prompt if one appears (see
   [Network and firewall](#network-and-firewall)).

2. **Create an invite (PC B).** Under **Invite a PC**, click **Create
   invite** and **Copy**. The invite looks like this:

   ```text
   wmux-a2a://office-pc:45660/K7QM2XPA#sha256=AB:CD:...&alt=10.0.4.21
   ```

   It names this PC (its machine name first, then up to four fallback IPv4
   addresses after `alt=`), the port, a one-time code, and the certificate
   fingerprint. The section lists the addresses the other PC will try. The
   invite is valid for **10 minutes** and survives **5** wrong attempts; one
   invite pairs one PC. Send it to PC A over any channel you trust; it is
   meant to be pasted, not clicked.

3. **Paste it (PC A).** On PC A, open the same section, paste the invite
   under **Paste an invite**, and click **Connect**. PC A does not need
   "Accept connections from other PCs" turned on to join. On success it says
   "Connected to *PC B's name*." PC B now appears on A under **PCs I
   connected to**, and PC A appears on B under **PCs connected to me**.

4. **Choose what to show (PC B).** Before anything can be linked, the server
   decides what the joiner may see. On PC B, under **PCs connected to me**,
   click **Panes to show** on PC A's row. Tick single panes, or a workspace's
   box to show every pane it has now (panes you open later are not added).
   Panes are named as their header shows them. Nothing is shown until you
   tick it.

5. **Link two panes (PC A, then PC B).** On PC A, open the pane's menu
   (right-click the pane header, or click **⋮**) and choose **Link with a
   pane on another PC…**. Pick PC B, then one of the panes it shows you.
   Each pane is listed as `<workspace> / <pane>` with its agent, git remote
   and branch, and working directory. Panes on the same repository as yours
   come first with a **Same repo** badge, and a different repository shows a
   warning. Two boxes set the directions, both ticked by default: **This
   pane may send work there** and **That pane may send work here**. Click
   **Send link request**.

   PC B shows a notice, "Another PC asks to link a pane", whose **Review**
   button opens the **Remote** page. Under **Links with other PCs**, the
   request card shows PC A's pane and repository (marked "as PC A reports
   it, not verified here"), your pane and repository as PC B knows them, the
   directions, and a warning when the repositories differ. Click **Accept**
   or **Decline**. When you accept, PC B checks again that the pane is still
   shown to PC A and still open. A request nobody answers ends after 24
   hours.

   Until PC B accepts, PC A lists the link as **Pending**; **Check** asks
   PC B for its current state. Both PCs list their links on the Remote page
   with their state, and a live link has an **Unlink** button.

6. **Send work.** Agents in the linked pane's workspace on PC A now see the
   remote pane in `a2a_discover` under an alias of the form
   `<PC>/<workspace>/<pane>`. The pane part is the pane's header name on
   PC B: its label if someone renamed it, otherwise its automatic name, for
   example `office-pc/api-server/w1-2(claude)`. The names are taken when the
   link is made; renaming a pane later does not change the alias. The entry
   also carries an id of the form `remote:<linkId>`, which works as a
   target too. If two links would have the same alias, the newer one gets
   `#2`, `#3` and so on.

   Only the linked pane can send on the link. Its agent calls
   `send_message` with the alias (or the `remote:` id) as it would for a
   local pane. The call returns at once with the task queued for PC B. The
   task is a message only (up to 32 KiB); `execute` is refused for a remote
   pane. PC B's agent answers on the task with `send_message` (with the
   task id) or `a2a_task_update`, and the reply arrives back in the sending
   pane on PC A. If the link allows it, PC B's agent can send to PC A the
   same way. Progress and replies are visible with `a2a_task_query`.

The two PCs do not need to be paired both ways. One pairing carries traffic
in both directions over the joiner's connection.

### Linking Moa

Moa on two PCs can be linked the same way. A Moa links only with the other
PC's Moa, never with a pane.

1. **PC B:** turn Moa on, then in **Panes to show** for PC A tick **Show this
   PC's Moa**.
2. **PC A:** with Moa on, open the **Remote** page and click **Link Moa with
   another PC…**. Pick PC B, choose its Moa and the directions, and send the
   request.
3. **PC B:** accept the card "*PC A*'s Moa asks to link with this PC's Moa"
   on the Remote page.

Moa then reaches the other PC's Moa as `<PC>/Moa` (for example
`office-pc/Moa`) with `send_message`. Moa cannot send to a remote pane's
alias; it is told to ask that PC's Moa instead. The Moa panel lists the work
exchanged with other PCs' Moa under **Other PCs' Moa**, with its state and
the other PC.

When work from another PC's Moa arrives, Moa is woken with a pointer to the
task, not its text, and reads it with `a2a_task_query`. The wake says the
text is a request from another PC, not your instruction, and that Moa should
do the work itself rather than hand it to another agent. Moa handles it with
its usual tools, which include asking you with a decision card. Wakes follow
the usual rules, plus a limit for other PCs:

- With **Auto-wake on pane events** turned off, Moa is not woken for it.
  The task is still in Moa's list (`a2a_task_query`) for its next turn.
- While Moa has a decision waiting for you, it is not woken. The pointer is
  kept and comes back once you answer.
- One PC can wake Moa at most 3 times in 10 minutes, with at most 5 of its
  items per wake. The rest wait for a later wake, and the wake says how many
  are waiting.
- Work for Moa that arrives before Moa can take it (for example while the
  app is still starting) is held and goes to Moa as soon as it can.

## Delivery, receipts and held work

The **Remote** page has a **Messages between PCs** section:

- **Connection.** Each paired PC shows as **Connected**, **Connecting**,
  **Disconnected**, or **Certificate changed**. While a PC is away, the row
  says how many messages will be sent when it reconnects. Messages stay
  queued on disk until the other PC confirms them, so a restart or a dropped
  connection neither loses nor repeats one.
- **Receipts.** The receiving PC reports twice: when the task reached its
  pane's agent (or its Moa), and when that side read the task by its id with
  `a2a_task_query`. The sender sees this as `remoteReceipt` (`delivered` or
  `read`) in `a2a_task_query`, and the Moa panel shows it as "they got it" or
  "they read it, answer pending". Receipts never change the task's state.
- **Held remote work.** Work is held for you, never sent to another pane on
  its own, when:
  - the pane it was meant for is gone,
  - another agent is in that pane now,
  - the link to that PC has ended,
  - it is for Moa and Moa cannot take it yet (it goes by itself once Moa
    can),
  - a paste was started but never confirmed (check the pane before sending
    again), or
  - the pane kept having no agent to take it.

  Each held item has **Reject**, which ends it and tells the other PC, and,
  except for work meant for Moa, **Send to the current agent**, which
  delivers it to the agent in that pane now. Held work that nobody handles
  is rejected automatically after 24 hours.

## Network and firewall

- **Port.** The listener uses TCP **45660** by default (clear of the phone
  web server's 7681 and LanLink's 45651). You can change it in the same
  section (1024–65535). If you change it after pairing, joiners keep the old
  port, so pair them again.
- **Who needs an open port.** Only the server (the PC that created the
  invite) accepts inbound connections. The joiner only connects out. If one
  PC cannot accept inbound connections, make it the joiner.
- **Bind address.** The listener binds all interfaces (`0.0.0.0`). Every
  request still needs a valid peer credential, and pairing needs an open
  invite.
- **No proxy.** The joiner connects directly. `HTTP_PROXY`/`HTTPS_PROXY`
  and similar settings are ignored on purpose, since the connection is
  pinned to one certificate.

### Windows

Windows Defender Firewall applies rules per network profile: **Domain**
(a company network that reaches a domain controller), **Private**, and
**Public**. Check which profile the LAN adapter is in with:

```powershell
Get-NetConnectionProfile
```

The first time the listener starts, Windows may ask whether to allow wmux;
the prompt may tick only Private networks. On a company network the adapter
is usually in the **Domain** profile, so the prompt's choice may not cover it,
and a Group Policy may hide the prompt altogether. To allow the port
explicitly, run in an **administrator** PowerShell on the server PC:

```powershell
New-NetFirewallRule -DisplayName "wmux cross-PC A2A" `
  -Direction Inbound -Protocol TCP -LocalPort 45660 `
  -Action Allow -Profile Domain,Private
```

Use your own port if you changed it. Leave `Public` out unless you have a
reason to include it. If your company manages the firewall centrally, a local
rule may have no effect; ask IT to allow the port.

### macOS

If the application firewall is on (System Settings > Network > Firewall),
macOS asks whether to allow incoming connections for wmux when the listener
starts. Click **Allow**. If you denied it earlier, open **Options…** and set
wmux to "Allow incoming connections". With "Block all incoming connections"
turned on, the Mac can only be a joiner.

### Wi-Fi and the network itself

- Many office and guest Wi-Fi networks use **client (AP) isolation**: devices
  on the same Wi-Fi cannot reach each other at all. Pairing then fails with
  a timeout. Use wired Ethernet, or ask IT whether isolation is on.
- **Wired LAN is recommended** for both PCs. It avoids isolation, keeps the
  address stable, and avoids sleep-related drops.
- Invites use the machine name first. If company DNS does not resolve it, the
  joiner falls back to the IPv4 addresses listed in the invite. After
  pairing, the joiner remembers both the name and the address it reached, so
  a later DHCP address change is not a problem as long as one of them still
  works. The certificate pin, not the address, is what identifies the PC.

## Troubleshooting

When **Connect** fails on the joiner, the message tells you which case it is:

| Message (joiner) | Cause | What to do |
| --- | --- | --- |
| This is not a wmux invite. | The pasted text is not a whole invite. | Copy the entire `wmux-a2a://…` line again. |
| This invite was created on this PC. | You pasted the invite on the PC that created it. | Paste it on the other PC. |
| The other PC's identity does not match this invite. | A different machine answered at that address, or the server's certificate was re-created (for example after its wmux data was reset). | Create a new invite on the server and pair again. Do not try to work around it. |
| The other PC refused the connection. | Nothing listens on that port: the feature is off on the server, wmux is not running there, or the port is wrong. | On the server, check that the section says "Listening on port …" and that the invite's port matches. |
| The other PC did not answer in time. | Usually a firewall dropping the port, Wi-Fi client isolation, or the server is asleep or offline. | Check [Network and firewall](#network-and-firewall). Try the server's IPv4 address, or a wired connection. |
| The other PC's name could not be found on this network. | The machine name does not resolve, and no fallback address answered. | Use a fresh invite; it lists the server's current IPv4 addresses. Or fix the DNS name. |
| This invite has expired or was cancelled. | More than 10 minutes passed, the invite was cancelled or replaced, or it ran out of attempts. | Create a new invite. |
| The invite code was not accepted. | The code does not match the open invite (often a truncated copy). | Copy the whole invite again. Each wrong code uses one of the 5 attempts. |
| That PC finished another pairing with this PC at the same moment. | Two pairings of the same PC raced. | Try again. |
| Too many failed attempts from this PC. | The server is rate-limiting this address after repeated failures. | Wait a minute, then try again with a correct invite. |
| The other PC runs an incompatible wmux version. | The two PCs speak different protocol versions. | Update both PCs to the same wmux version. |
| Connecting failed. Try again. | Any other failure, such as an unreadable answer from the server or this PC failing to save the pairing. | Try again. If it keeps failing, check that both PCs run the same wmux version. |

On the server, "Not listening: …" means the listener could not start, most
often because another program already uses the port. Pick another port.

After pairing, if the server's certificate changes (it is re-created only
when it is missing, damaged or within 30 days of expiry), the joiner stops
talking to it. Its row on the joiner's **Remote** page shows **Certificate
changed**: nothing is sent to that PC until you remove it and pair again. No
data is sent to a PC whose certificate does not match.

## Security model

The trust boundary of this experimental version is **your own PCs**. Pair
only machines you control. Support for colleagues' PCs needs further
hardening and will come later.

- **Why remote work cannot run anything.** A task from another PC is
  delivered as a message to the linked pane, and only to that pane. wmux does
  not spawn a worker, open a pane, or run a command for it, and it goes
  through the same approval and hold checks as a local task. If the pane is
  gone, or the agent in it is no longer the one the task belongs to, the
  message is held for you instead of being delivered or re-routed to another
  pane (see [Delivery, receipts and held work](#delivery-receipts-and-held-work)).
  What the receiving agent decides to do with a message is up to that agent
  and its own permissions, just as with a message you type yourself.
- **What a link covers.** A link joins exactly one pane on each side, or the
  Moa of each side, in the directions you allowed. A paired PC sees only the
  panes (and Moa) you showed it, can propose links only to those, and can
  send only over a link that a person on one PC proposed and a person on the
  other accepted. The receiving PC decides which pane a message came from by
  its own link record, never by what the sender claims.
- **When a link ends by itself.** A link breaks when its pane is closed or
  moves to another workspace, when its workspace is closed or archived, when
  the server stops showing that pane (or its Moa) to the other PC, or, for a
  Moa link, when Moa is turned off or its workspace goes away. The Remote
  page shows the link as **Disconnected** with the reason. A broken link
  stays ended: restoring an archived workspace does not bring it back. Link
  the panes again.
- **Removing access.** Either PC can end a link at any time with **Unlink**
  on the Remote page. When a link ends for any reason, its open tasks fail
  on both PCs, and anything the other PC sent that was not delivered yet is
  held, never delivered later. To end the pairing itself, use **Remove**
  under "PCs I connected to" on the joiner (it also tells the server, when
  reachable) or **Disconnect** under "PCs connected to me" on the server;
  either ends every link with that PC. Turning off **Accept connections from
  other PCs** stops the listener.
- **Text from another PC.** Before a message from another PC is stored, and
  again right before it is written to a pane, wmux removes terminal escape
  sequences (including clipboard writes and the end-of-paste marker) and
  control characters other than newline and tab, and turns a carriage
  return into a newline. PC, workspace and pane names in an alias keep only
  printable characters, with `/` turned into `-`. A wake for Moa carries
  only the task id and the PC name, never the message text.
- **Where credentials live.** Pairing issues the joiner a peer credential
  that works only on the A2A listener's `/api/a2a/*` routes. It is not a
  phone or device token and opens nothing else. The joiner keeps it in its
  wmux data directory (`a2a/remote-hosts.json`), readable only by your user
  account. The server keeps only a salted hash of it (`a2a/peers.json`). The
  listener's private key is also stored owner-only in `a2a/`.
- **Colleagues' PCs.** Not supported in this version. Before wmux allows
  pairing with a PC someone else controls, the model around execution,
  exposure and acceptance will be tightened.

## Known limitations

- Only the joiner can propose a link. The server accepts or declines it.
- Links are created by people only; agents cannot propose one.
- A pane links only with a pane, and Moa only with Moa. Moa cannot send to a
  pane on another PC, and a pane cannot send to another PC's Moa.
- No delivery without the app: a message reaches a pane or Moa only while
  the wmux app is open on the receiving PC. With only the daemon running, it
  waits and is delivered when the app comes back.
- Not yet verified on real Windows PCs.
- Each PC's identity is the id it reports when pairing; what wmux verifies
  is the server's certificate pin. This will be hardened before colleagues'
  PCs are supported.
- Moa is told to do work from another PC's Moa itself: an answer from an
  agent Moa handed it to would not get back to the other PC.
- No automatic discovery: pair with an invite. There is no PIN alternative.
- Accepting a link from a phone is not supported.
- Names in an alias are fixed when the link is made.
- wmux does not add firewall rules for you.
- Only basic rate limits apply.

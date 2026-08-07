### Added

- **Webhook and ntfy notifications, no phone app required.** Point
  `notifySinks` in `~/.wmux/config.json` at a webhook URL or an ntfy topic and
  the daemon pings it when an agent asks for an approval or finishes a turn.
  Until now the only way to hear about a blocked agent from away from the
  keyboard was the iOS app and its push relay; this is the plain-HTTP path for
  everyone else. Off unless you configure it, outbound only — the daemon opens
  no new port — and `WMUX_NOTIFY_SINKS=0` turns it off without editing config.

  ```json
  "notifySinks": [
    { "type": "ntfy", "url": "https://ntfy.sh/my-topic", "events": ["approval"] },
    { "type": "webhook", "url": "https://hooks.example/wmux" }
  ]
  ```

  The ping is deliberately thin: the event kind, a fixed title, the agent name,
  short pane and workspace id prefixes, a derived risk tier and a timestamp. It
  never carries the agent's question, tool input, terminal output, file paths or
  any id that can address a pane — the destination is a server you chose but the
  body travels in the clear, and a shared ntfy topic is not the place for your
  terminal. Approvals go out at ntfy's high priority; turn-completions at
  default.

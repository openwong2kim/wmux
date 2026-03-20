# wmux MCP Server

MCP server that lets Claude Code control wmux's browser and terminal.
Supports multi-agent use — each agent can target its own browser via `surfaceId`.

## Setup

1. Build the MCP server:
   ```bash
   npm run build:mcp
   ```

2. Add to your project's `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "wmux": {
         "command": "node",
         "args": ["<path-to-wmux>/dist/mcp/mcp/index.js"]
       }
     }
   }
   ```

   `WMUX_SOCKET_PATH` and `WMUX_AUTH_TOKEN` are automatically set in wmux
   terminal sessions. When running Claude Code inside wmux, no extra env
   config is needed.

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate browser to URL |
| `browser_snapshot` | Get page HTML |
| `browser_click` | Click element by CSS selector |
| `browser_fill` | Fill input by CSS selector |
| `browser_eval` | Execute JS in browser |
| `terminal_read` | Read terminal screen |
| `terminal_send` | Send text to terminal |
| `terminal_send_key` | Send key (enter, ctrl+c, etc.) |
| `workspace_list` | List workspaces |
| `surface_list` | List surfaces (terminals + browsers) |
| `pane_list` | List panes |

## Multi-Agent Usage

All browser tools accept an optional `surfaceId` parameter. Use `surface_list`
to discover available surfaces, then pass the browser surface's ID:

```
1. Call surface_list → find your browser surface ID
2. Call browser_navigate with surfaceId="<your-browser-id>"
3. Call browser_snapshot with surfaceId="<your-browser-id>"
```

When `surfaceId` is omitted, the currently active browser surface is used.

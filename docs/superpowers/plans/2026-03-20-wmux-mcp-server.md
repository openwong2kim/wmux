# wmux MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an MCP server that exposes wmux's browser and terminal controls as tools Claude Code can call directly. Support multi-agent use by allowing `surfaceId` targeting so each agent controls its own browser/terminal.

**Architecture:** Standalone Node.js stdio process using `@modelcontextprotocol/sdk`. Connects to wmux via Named Pipe RPC (reusing `src/cli/client.ts` logic). Claude Code registers it in `.mcp.json`. Renderer-side RPC handlers and BrowserPanel are extended to support `surfaceId`-based targeting.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node.js `net` module (Named Pipe client)

**Important:** The MCP server communicates via stdio (stdin/stdout). Never use `console.log` in MCP server code — it corrupts the JSON-RPC protocol stream. Use `console.error` for diagnostics (goes to stderr).

---

### Task 1: Install MCP SDK and Zod dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the MCP SDK and Zod**

```bash
npm install @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@modelcontextprotocol/sdk/server/mcp.js')"
```

Expected: no error

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk and zod dependencies"
```

---

### Task 2: Add `data-surface-id` to BrowserPanel webview

**Files:**
- Modify: `src/renderer/components/Browser/BrowserPanel.tsx:204-214`

Currently the `<webview>` tag has no `data-surface-id` attribute, but `useRpcBridge.ts:findActiveBrowserWebview` queries for it. We need to add the attribute so webviews can be targeted by surfaceId.

- [ ] **Step 1: Pass surfaceId to webview as data attribute**

In `BrowserPanel.tsx`, the component receives `surfaceId` prop but doesn't use it on the `<webview>`. Change the destructure on line 45 and add the attribute:

In line 45, change:
```typescript
export default function BrowserPanel({ initialUrl, isActive, onClose }: BrowserPanelProps) {
```
to:
```typescript
export default function BrowserPanel({ surfaceId, initialUrl, isActive, onClose }: BrowserPanelProps) {
```

In the webview tag (line 206-214), add `data-surface-id`:
```tsx
<webview
  ref={webviewRef as React.RefObject<Electron.WebviewTag>}
  src={initialUrl}
  partition="persist:browser"
  data-surface-id={surfaceId}
  style={{
    width: '100%',
    height: '100%',
    display: 'flex',
  }}
/>
```

- [ ] **Step 2: Verify app still compiles**

```bash
npm start
```

Expected: app launches, browser surface works as before

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Browser/BrowserPanel.tsx
git commit -m "fix: add data-surface-id attribute to browser webview"
```

---

### Task 3: Extend renderer RPC handlers to support surfaceId targeting

**Files:**
- Modify: `src/renderer/hooks/useRpcBridge.ts:346-409`

Currently `findActiveBrowserWebview` only finds the **active** browser surface. We need a new function `findBrowserWebviewBySurfaceId` that can target any browser surface by its `surfaceId`. The browser.* RPC handlers should accept an optional `surfaceId` param.

- [ ] **Step 1: Add `findBrowserWebviewBySurfaceId` function**

Add after the existing `findActiveBrowserWebview` function (after line 373):

```typescript
/**
 * Finds a specific browser Surface's webview by surfaceId.
 * Falls back to findActiveBrowserWebview if surfaceId is not provided.
 */
function findBrowserWebviewBySurfaceId(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  surfaceId?: string,
): HTMLElement | { error: string } {
  if (!surfaceId) return findActiveBrowserWebview(store);

  const safeSurfaceId = CSS.escape(surfaceId);
  const webview = document.querySelector<HTMLElement>(
    `webview[data-surface-id="${safeSurfaceId}"]`,
  );
  if (webview) return webview;
  return { error: `browser: surface ${surfaceId} not found or not a browser` };
}
```

- [ ] **Step 2: Update browser.* handlers to use `surfaceId` param**

Change `handleBrowserSnapshot`, `handleBrowserExec`, `handleBrowserNavigate` to accept optional `surfaceId`:

```typescript
async function handleBrowserSnapshot(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
  const html = await wv.executeJavaScript('document.documentElement.outerHTML');
  return { html };
}

async function handleBrowserExec(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  code: string,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
  const result = await wv.executeJavaScript(code);
  return { result };
}

async function handleBrowserNavigate(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  url: string,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { loadURL: (url: string) => Promise<void> };
  await wv.loadURL(url);
  return { ok: true, url };
}
```

- [ ] **Step 3: Pass `surfaceId` from browser.* dispatch calls**

Update the browser method dispatches to pass `params.surfaceId`:

```typescript
if (method === 'browser.snapshot') {
  const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
  return handleBrowserSnapshot(store, surfaceId);
}

if (method === 'browser.click') {
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
  if (!selector) return { error: 'browser.click: missing selector' };
  return handleBrowserExec(store, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    el.click();
    return { ok: true, selector: ${JSON.stringify(selector)} };
  `, surfaceId);
}

if (method === 'browser.fill') {
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const text = typeof params.text === 'string' ? params.text : '';
  const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
  if (!selector) return { error: 'browser.fill: missing selector' };
  return handleBrowserExec(store, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.value = ${JSON.stringify(text)};
    }
    return { ok: true };
  `, surfaceId);
}

if (method === 'browser.eval') {
  const code = typeof params.code === 'string' ? params.code : '';
  const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
  if (!code) return { error: 'browser.eval: missing code' };
  const dangerousPatterns = [
    /\brequire\s*\(/i,
    /\bprocess\s*\./i,
    /\b__dirname\b/i,
    /\b__filename\b/i,
    /\bchild_process\b/i,
    /\bglobal\s*\.\s*process\b/i,
    /\belectron\b/i,
  ];
  for (const pat of dangerousPatterns) {
    if (pat.test(code)) {
      return { error: 'browser.eval: code contains blocked pattern' };
    }
  }
  return handleBrowserExec(store, code, surfaceId);
}

if (method === 'browser.navigate') {
  const url = typeof params.url === 'string' ? params.url : '';
  const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
  if (!url) return { error: 'browser.navigate: missing url' };
  const normalizedUrl = url.trim().toLowerCase();
  if (
    normalizedUrl.startsWith('javascript:') ||
    normalizedUrl.startsWith('data:') ||
    normalizedUrl.startsWith('vbscript:') ||
    normalizedUrl.startsWith('file:')
  ) {
    return { error: `browser.navigate: blocked URL scheme in "${url}"` };
  }
  return handleBrowserNavigate(store, url, surfaceId);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useRpcBridge.ts
git commit -m "feat: support surfaceId targeting in browser RPC handlers"
```

---

### Task 4: Extend main process browser RPC to pass surfaceId

**Files:**
- Modify: `src/main/pipe/handlers/browser.rpc.ts`

The main process browser RPC handlers need to forward the optional `surfaceId` param to the renderer.

- [ ] **Step 1: Update all browser.* handlers to pass surfaceId**

```typescript
router.register('browser.snapshot', (params) => {
  const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
  return sendToRenderer(getWindow, 'browser.snapshot', surfaceId ? { surfaceId } : {});
});

router.register('browser.click', (params) => {
  if (typeof params['selector'] !== 'string' || params['selector'].length === 0) {
    throw new Error('browser.click: missing required param "selector"');
  }
  const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
  return sendToRenderer(getWindow, 'browser.click', {
    selector: params['selector'],
    ...(surfaceId && { surfaceId }),
  });
});

router.register('browser.fill', (params) => {
  if (typeof params['selector'] !== 'string' || params['selector'].length === 0) {
    throw new Error('browser.fill: missing required param "selector"');
  }
  if (typeof params['text'] !== 'string') {
    throw new Error('browser.fill: missing required param "text"');
  }
  const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
  return sendToRenderer(getWindow, 'browser.fill', {
    selector: params['selector'],
    text: params['text'],
    ...(surfaceId && { surfaceId }),
  });
});

router.register('browser.eval', (params) => {
  if (typeof params['code'] !== 'string' || params['code'].length === 0) {
    throw new Error('browser.eval: missing required param "code"');
  }
  const code = params['code'];
  const dangerousPatterns = [
    /\brequire\s*\(/i,
    /\bprocess\s*\./i,
    /\b__dirname\b/i,
    /\b__filename\b/i,
    /\bchild_process\b/i,
    /\bglobal\s*\.\s*process\b/i,
    /\belectron\b/i,
  ];
  for (const pat of dangerousPatterns) {
    if (pat.test(code)) {
      throw new Error('browser.eval: code contains blocked pattern');
    }
  }
  const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
  return sendToRenderer(getWindow, 'browser.eval', {
    code,
    ...(surfaceId && { surfaceId }),
  });
});

router.register('browser.navigate', (params) => {
  if (typeof params['url'] !== 'string' || params['url'].length === 0) {
    throw new Error('browser.navigate: missing required param "url"');
  }
  const url = params['url'];
  const normalizedUrl = url.trim().toLowerCase();
  if (
    normalizedUrl.startsWith('javascript:') ||
    normalizedUrl.startsWith('data:') ||
    normalizedUrl.startsWith('vbscript:') ||
    normalizedUrl.startsWith('file:')
  ) {
    throw new Error(`browser.navigate: blocked URL scheme`);
  }
  const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
  return sendToRenderer(getWindow, 'browser.navigate', {
    url,
    ...(surfaceId && { surfaceId }),
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/main/pipe/handlers/browser.rpc.ts
git commit -m "feat: forward surfaceId in browser RPC handlers"
```

---

### Task 5: Create MCP tsconfig

**Files:**
- Create: `tsconfig.mcp.json`

- [ ] **Step 1: Create tsconfig.mcp.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist/mcp",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": [
    "src/mcp/**/*",
    "src/shared/rpc.ts",
    "src/shared/constants.ts",
    "src/shared/types.ts"
  ],
  "exclude": [
    "node_modules",
    "src/main/**/*",
    "src/renderer/**/*",
    "src/preload/**/*",
    "src/cli/**/*"
  ]
}
```

- [ ] **Step 2: Add build script to package.json**

Add to `"scripts"`:
```json
"build:mcp": "tsc -p tsconfig.mcp.json"
```

- [ ] **Step 3: Commit**

```bash
git add tsconfig.mcp.json package.json
git commit -m "chore: add MCP server build config"
```

---

### Task 6: Create Named Pipe RPC client for MCP

**Files:**
- Create: `src/mcp/wmux-client.ts`

This is a simplified version of `src/cli/client.ts`. It reads `WMUX_SOCKET_PATH` and `WMUX_AUTH_TOKEN` from environment variables (injected by wmux into PTY sessions).

- [ ] **Step 1: Create src/mcp/wmux-client.ts**

```typescript
import * as net from 'net';
import * as crypto from 'crypto';
import type { RpcMethod, RpcResponse } from '../shared/rpc';

const TIMEOUT_MS = 10000;

export function sendRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const pipePath = process.env.WMUX_SOCKET_PATH;
  const token = process.env.WMUX_AUTH_TOKEN;

  if (!pipePath) {
    return Promise.reject(new Error('WMUX_SOCKET_PATH not set. Is this running inside wmux?'));
  }
  if (!token) {
    return Promise.reject(new Error('WMUX_AUTH_TOKEN not set. Is this running inside wmux?'));
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const request = JSON.stringify({ id, method, params, token }) + '\n';

    const socket = net.connect(pipePath);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`RPC timeout: ${method} (${TIMEOUT_MS}ms)`));
      }
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(request);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed) as RpcResponse;
          if (response.id === id && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (response.ok) {
              resolve(response.result);
            } else {
              reject(new Error(response.error));
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('wmux is not running. Start the app first.'));
        } else {
          reject(new Error(`Connection error: ${err.message}`));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response was received.'));
      }
    });
  });
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build:mcp
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/wmux-client.ts
git commit -m "feat(mcp): add Named Pipe RPC client"
```

---

### Task 7: Create MCP server with tool definitions

**Files:**
- Create: `src/mcp/index.ts`

All tools accept optional `surfaceId` for multi-agent targeting. When omitted, the active surface is used (backwards compatible).

- [ ] **Step 1: Create src/mcp/index.ts**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';

const server = new McpServer({
  name: 'wmux',
  version: '1.0.0',
});

// Helper: wrap an RPC call as an MCP tool result
async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const result = await sendRpc(method, params);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Optional surfaceId schema used by browser and terminal tools
const optionalSurfaceId = z.string().optional().describe(
  'Target a specific surface by ID. Omit to use the active surface.',
);

// === Browser tools ===

server.tool(
  'browser_navigate',
  'Navigate the wmux browser panel to a URL',
  {
    url: z.string().describe('The URL to navigate to'),
    surfaceId: optionalSurfaceId,
  },
  async ({ url, surfaceId }) =>
    callRpc('browser.navigate', { url, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_snapshot',
  'Get the full HTML content of the current page in the wmux browser panel',
  { surfaceId: optionalSurfaceId },
  async ({ surfaceId }) =>
    callRpc('browser.snapshot', surfaceId ? { surfaceId } : {}),
);

server.tool(
  'browser_click',
  'Click an element in the wmux browser panel by CSS selector',
  {
    selector: z.string().describe('CSS selector of the element to click'),
    surfaceId: optionalSurfaceId,
  },
  async ({ selector, surfaceId }) =>
    callRpc('browser.click', { selector, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_fill',
  'Fill an input field in the wmux browser panel by CSS selector',
  {
    selector: z.string().describe('CSS selector of the input element'),
    text: z.string().describe('Text to fill into the input'),
    surfaceId: optionalSurfaceId,
  },
  async ({ selector, text, surfaceId }) =>
    callRpc('browser.fill', { selector, text, ...(surfaceId && { surfaceId }) }),
);

server.tool(
  'browser_eval',
  'Execute JavaScript in the wmux browser panel and return the result',
  {
    code: z.string().describe('JavaScript code to execute in the browser context'),
    surfaceId: optionalSurfaceId,
  },
  async ({ code, surfaceId }) =>
    callRpc('browser.eval', { code, ...(surfaceId && { surfaceId }) }),
);

// === Terminal tools ===

server.tool(
  'terminal_read',
  'Read the current visible text from the active terminal in wmux',
  {},
  async () => callRpc('input.readScreen'),
);

server.tool(
  'terminal_send',
  'Send text to the active terminal in wmux',
  { text: z.string().describe('Text to send to the terminal') },
  async ({ text }) => callRpc('input.send', { text }),
);

server.tool(
  'terminal_send_key',
  'Send a named key to the active terminal (enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left)',
  {
    key: z.string().describe(
      'Key name: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left',
    ),
  },
  async ({ key }) => callRpc('input.sendKey', { key }),
);

// === Workspace tools ===

server.tool(
  'workspace_list',
  'List all workspaces in wmux',
  {},
  async () => callRpc('workspace.list'),
);

server.tool(
  'surface_list',
  'List all surfaces (terminals and browsers) in the active workspace',
  {},
  async () => callRpc('surface.list'),
);

server.tool(
  'pane_list',
  'List all panes in the current workspace',
  {},
  async () => callRpc('pane.list'),
);

// === Start server ===

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build:mcp
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/index.ts
git commit -m "feat(mcp): add MCP server with surfaceId targeting for multi-agent use"
```

---

### Task 8: Add npm scripts and verify end-to-end build

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add mcp script to package.json**

Add to `"scripts"`:
```json
"mcp": "node dist/mcp/mcp/index.js"
```

Add to `"bin"`:
```json
"wmux-mcp": "dist/mcp/mcp/index.js"
```

- [ ] **Step 2: Build and verify output exists**

```bash
npm run build:mcp && ls dist/mcp/mcp/index.js
```

Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(mcp): add mcp build script and bin entry"
```

---

### Task 9: Test MCP server startup

**Files:** (none - manual test)

- [ ] **Step 1: Build the MCP server**

```bash
npm run build:mcp
```

- [ ] **Step 2: Verify the server starts and responds to initialize**

Run wmux first, then in a wmux terminal:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node dist/mcp/mcp/index.js
```

Expected: JSON response with server info and 11 tools

---

### Task 10: Document usage

**Files:**
- Create: `src/mcp/README.md`

- [ ] **Step 1: Create usage documentation**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/README.md
git commit -m "docs: add MCP server usage guide with multi-agent instructions"
```

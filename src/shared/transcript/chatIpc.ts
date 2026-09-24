/** Private desktop IPC; never registered on the public MCP router. */
export const CHAT_IPC = {
  settings: 'chat:settings',
  skills: 'chat:skills',
  launchTerminal: 'chat:launch-terminal',
  close: 'chat:close', providers: 'chat:providers', start: 'chat:start', reconnect: 'chat:reconnect', cancel: 'chat:cancel', respond: 'chat:respond',
  status: 'chat:status', snapshot: 'chat:snapshot', subscribe: 'chat:subscribe',
  unsubscribe: 'chat:unsubscribe', codeBlock: 'chat:code-block',
  append: 'chat:append', gate: 'chat:gate', openGates: 'chat:open-gates', send: 'chat:send',
} as const;

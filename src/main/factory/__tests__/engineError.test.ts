import { describe, expect, it } from 'vitest';
import { classifyEngineError, claudeNotFoundMessage, isSubscriptionRefusal } from '../engineError';

describe('classifyEngineError', () => {
  it('maps known engine_unavailable messages', () => {
    expect(classifyEngineError('Claude Code is not installed (no claude executable found)')).toBe('not_installed');
    expect(classifyEngineError('the wmux MCP bundle was not found, so the bot would have no tools')).toBe('mcp_missing');
    expect(classifyEngineError('ACP engines run bots only in a test build of wmux in this version; switch this bot to Claude (SDK) in its profile')).toBe('acp_test_only');
    expect(classifyEngineError('Claude is installed but could not run (claude --version exited 127).')).toBe('unusable');
    expect(classifyEngineError('Claude Code is not signed in.')).toBe('not_logged_in');
  });

  it('maps the setup failures the SDK adapter reports during a turn', () => {
    expect(classifyEngineError('Not logged in · Please run /login')).toBe('not_logged_in');
    expect(classifyEngineError('Failed to spawn Claude Code process: spawn EACCES')).toBe('unusable');
    expect(classifyEngineError('Claude Code native binary at /opt/claude exists but failed to launch. This usually means the binary does not match this system')).toBe('unusable');
    expect(classifyEngineError('Claude Code executable not found at /usr/local/bin/claude. Is options.pathToClaudeCodeExecutable set?')).toBe('not_installed');
  });

  it('a broken claude at turn time is unusable; claude removed while wmux runs (the adapters\' own words) is not installed', () => {
    expect(classifyEngineError('Claude Code process exited with code 1')).toBe('unusable');
    expect(classifyEngineError(claudeNotFoundMessage('commander'))).toBe('not_installed');
    expect(classifyEngineError(claudeNotFoundMessage('terminal brain'))).toBe('not_installed');
    expect(classifyEngineError('Claude Code process exited with code 0')).toBe('other');
  });

  it('unknown text is other', () => {
    expect(classifyEngineError('something else went wrong')).toBe('other');
    expect(classifyEngineError('')).toBe('other');
  });
});

describe('isSubscriptionRefusal', () => {
  it('matches the subscription refusing a bot request', () => {
    expect(isSubscriptionRefusal('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not supported."}}')).toBe(true);
    expect(isSubscriptionRefusal('This credential is only authorized for use with Claude Code and cannot be used for other API requests.')).toBe(true);
    expect(isSubscriptionRefusal('Third-party apps draw from your extra usage, not your plan limits.')).toBe(true);
    expect(isSubscriptionRefusal('Claude Code returned an error result: API Error: 401 subscription not valid for this request')).toBe(true);
  });

  it('leaves a signed-out or expired sign-in, a usage limit and other errors alone', () => {
    expect(isSubscriptionRefusal('API Error: 401 {"error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login')).toBe(false);
    expect(isSubscriptionRefusal('Not logged in · Please run /login')).toBe(false);
    expect(isSubscriptionRefusal("You've hit your session limit · resets 1pm (Asia/Seoul)")).toBe(false);
    expect(isSubscriptionRefusal('API Error: 403 forbidden')).toBe(false);
    expect(isSubscriptionRefusal('API Error: 529 overloaded_error')).toBe(false);
    expect(isSubscriptionRefusal('')).toBe(false);
  });

  it('a bot set to an API key with none usable here maps to its own code', () => {
    expect(classifyEngineError('Bots are set to run on a Claude API key, but no key is saved on this computer: add one in Settings › Bots')).toBe('api_key_missing');
  });
});

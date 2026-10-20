import { describe, expect, it } from 'vitest';
import {
  BOT_BASE_RPC,
  BOT_TEARDOWN_DENY,
  BOT_TOOL_RPC,
  COORDINATOR_READ_EXTENSION,
  FACTORY_RPC_METHODS,
  ROLE_SURFACES,
  SHARED_SURFACE,
  SHARED_SURFACE_TOOLS,
  botSurfaceOf,
  botSurfaceRefusal,
  factoryNotImplemented,
} from '../botSurface';
import { BOT_ROLES, type BotRole } from '../bot';
import { ALL_RPC_METHODS } from '../rpc';
import { COMMANDER_RPC_METHODS, COMMANDER_TOOL_SURFACE, COMMANDER_ONLY_TOOLS } from '../commanderSurface';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';
import { METHOD_CAPABILITY, resolveRequiredCapability } from '../../main/mcp/methodCapabilityMap';
import type { RpcMethod } from '../rpc';

const COMMON = ['ask_person', 'room_post', 'room_read', 'room_search', 'handoff_send', 'fact_poll'];

describe('ROLE_SURFACES', () => {
  it('defines every role', () => {
    expect(Object.keys(ROLE_SURFACES).sort()).toEqual([...BOT_ROLES].sort());
  });

  it.each(BOT_ROLES)('%s holds the tools every role has', (role) => {
    for (const tool of COMMON) expect(ROLE_SURFACES[role].tools.has(tool), `${role} lacks ${tool}`).toBe(true);
  });

  it.each(BOT_ROLES)('%s holds no shell, terminal input, teardown, browser or computer tool', (role) => {
    for (const tool of ROLE_SURFACES[role].tools) {
      expect(tool).not.toMatch(/^(terminal_send|terminal_send_key|send_message|pane_close|surface_close|workspace_close|pane_split|surface_new|computer|approval_press|task_close|task_pr|task_adopt)$/);
      expect(tool).not.toMatch(/^(browser_|repl_|company_)/);
    }
  });

  it('every role tag maps to the one shared surface', () => {
    for (const role of BOT_ROLES) {
      expect(ROLE_SURFACES[role]).toBe(SHARED_SURFACE);
      expect(botSurfaceOf()).toBe(SHARED_SURFACE);
    }
    expect(new Set(SHARED_SURFACE.tools)).toEqual(new Set(SHARED_SURFACE_TOOLS));
    expect(SHARED_SURFACE_TOOLS.length).toBe(new Set(SHARED_SURFACE_TOOLS).size);
  });

  it('every bot can start workers with every bot preset, record a verdict and plan', () => {
    for (const tool of ['fanout_start', 'pr_verdict', 'plan_propose', 'bot_list', 'issue_read', 'pr_read', 'ci_read']) {
      expect(SHARED_SURFACE.tools.has(tool), tool).toBe(true);
    }
    expect([...SHARED_SURFACE.fanoutPresets].sort()).toEqual(['default', 'maintain', 'repro', 'research', 'verify']);
    expect(SHARED_SURFACE.rpc.has('task.fanout.start')).toBe(true);
    expect(SHARED_SURFACE.rpc.has('verify.recordVerdict')).toBe(true);
  });

  it('holds the shared bot tools: own job, routines, stop, approval and secret requests', () => {
    for (const tool of ['job_set', 'routine_set', 'routine_list', 'routine_pause', 'stop_my_work',
      'approval_request', 'approval_list', 'secret_request', 'secret_list', 'login_request']) {
      expect(SHARED_SURFACE.tools.has(tool), tool).toBe(true);
    }
  });

  it('no bot parks another: bot_park is a tool on no surface', () => {
    expect('bot_park' in BOT_TOOL_RPC).toBe(true);
    expect(SHARED_SURFACE.tools.has('bot_park')).toBe(false);
    expect(SHARED_SURFACE.rpc.has('bot.park')).toBe(false);
  });

  it('room.search is every bot\'s, in its own room only: no Coordinator extension covers it', () => {
    expect(BOT_TOOL_RPC.room_search).toEqual(['room.search']);
    expect(SHARED_SURFACE.rpc.has('room.search')).toBe(true);
    expect(FACTORY_RPC_METHODS).toContain('room.search');
    expect('room.search' in COORDINATOR_READ_EXTENSION).toBe(false);
  });

  it('the Coordinator extension names only read methods already on the surface (and plan.propose)', () => {
    for (const m of Object.keys(COORDINATOR_READ_EXTENSION)) {
      expect(SHARED_SURFACE.rpc.has(m), m).toBe(true);
      expect(m).toMatch(/^(room\.(read|threads)|fact\.poll|pr\.read|issue\.read|ci\.read|verdict\.read|trustMetrics\.read|plan\.propose)$/);
    }
  });

  it('no owner-held write is a bot method: approvals are granted and secrets stored only by main', () => {
    for (const m of SHARED_SURFACE.rpc) {
      expect(m).not.toMatch(/approve|decide|grant|secret\.set|botSecret\.(set|delete)/i);
    }
  });

  it.each(BOT_ROLES)('%s rpc = base ∪ the methods of its tools, exactly', (role) => {
    const expected = new Set<string>(BOT_BASE_RPC);
    for (const tool of ROLE_SURFACES[role].tools) {
      for (const m of BOT_TOOL_RPC[tool as keyof typeof BOT_TOOL_RPC]) expected.add(m);
    }
    expect(new Set(ROLE_SURFACES[role].rpc)).toEqual(expected);
  });

  it.each(BOT_ROLES)('%s reaches no teardown method and no operator-only factory method', (role) => {
    for (const m of BOT_TEARDOWN_DENY) expect(ROLE_SURFACES[role].rpc.has(m)).toBe(false);
    for (const m of ['bot.create', 'bot.update', 'bot.remove', 'bot.wake', 'bot.resume', 'bot.interrupt', 'bot.status',
      'room.resolve', 'handoff.answer', 'handoff.list', 'fact.emit', 'input.send', 'input.sendKey']) {
      expect(ROLE_SURFACES[role].rpc.has(m), `${role} reaches ${m}`).toBe(false);
    }
  });

  it('every surface method is a mapped RpcMethod the bundled server is allowed to call', () => {
    for (const role of BOT_ROLES) {
      for (const m of ROLE_SURFACES[role].rpc) {
        expect(m in METHOD_CAPABILITY, `${m} has no capability entry`).toBe(true);
        const bootstrap = resolveRequiredCapability(METHOD_CAPABILITY[m as RpcMethod], {}) === null;
        expect(
          bootstrap || FIRST_PARTY_METHODS.has(m as RpcMethod),
          `${m} (on the ${role} surface) is neither identity bootstrap nor first-party`,
        ).toBe(true);
      }
    }
  });

  it('existing tool names on a surface are tools the commander profile already registers', () => {
    const existing = new Set([...COMMANDER_TOOL_SURFACE, ...COMMANDER_ONLY_TOOLS]);
    for (const tool of ['workspace_list', 'pane_list', 'terminal_read', 'fleet_triage', 'ledger_update', 'fanout_start', 'wmux_events_poll', 'a2a_task_query']) {
      expect(existing.has(tool), tool).toBe(true);
      for (const m of BOT_TOOL_RPC[tool as keyof typeof BOT_TOOL_RPC]) {
        expect(COMMANDER_RPC_METHODS.has(m), `${tool} → ${m}`).toBe(true);
      }
    }
  });

  it('FACTORY_RPC_METHODS are unique RpcMethods in ALL_RPC_METHODS', () => {
    const all = new Set<string>(ALL_RPC_METHODS);
    expect(new Set(FACTORY_RPC_METHODS).size).toBe(FACTORY_RPC_METHODS.length);
    for (const m of FACTORY_RPC_METHODS) {
      expect(all.has(m), m).toBe(true);
      expect(METHOD_CAPABILITY[m]).toEqual({ capability: 'wmux.internal' });
    }
  });
});

describe('botSurfaceRefusal', () => {
  it('passes a method on the shared surface, whatever the role tag', () => {
    for (const role of BOT_ROLES) {
      expect(botSurfaceRefusal(role, 'verify.recordVerdict')).toBeNull();
      expect(botSurfaceRefusal(role, 'plan.propose')).toBeNull();
      expect(botSurfaceRefusal(role, 'task.fanout.start')).toBeNull();
      expect(botSurfaceRefusal(role, 'bot.setJob')).toBeNull();
      expect(botSurfaceRefusal(role, 'mcp.identify')).toBeNull();
    }
  });

  it('refuses a method off the surface', () => {
    expect(botSurfaceRefusal('verifier', 'input.send')).toBe('surface');
    expect(botSurfaceRefusal('lead', 'bot.create')).toBe('surface');
    expect(botSurfaceRefusal('moa', 'bot.park')).toBe('surface');
    expect(botSurfaceRefusal('moa', 'bot.update')).toBe('surface');
  });

  it('names teardown first', () => {
    expect(botSurfaceRefusal('lead', 'pane.close')).toBe('teardown');
    expect(botSurfaceRefusal('moa', 'workspace.close')).toBe('teardown');
  });

  it('fails closed for a role that is not one', () => {
    expect(botSurfaceRefusal('wizard' as BotRole, 'mcp.identify')).toBe('surface');
  });
});

describe('factoryNotImplemented', () => {
  it('is a typed refusal result', () => {
    expect(factoryNotImplemented('room.post')).toEqual({
      ok: false,
      code: 'not_implemented',
      method: 'room.post',
      message: 'room.post is not available in this build',
    });
  });
});

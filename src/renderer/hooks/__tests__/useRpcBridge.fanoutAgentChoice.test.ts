import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyRoleAgent } from '../../../shared/orchestratorRole';
import { withRoleBinding } from '../../utils/ptyCreateOptions';
import {
  FANOUT_EXTRA_AGENT_STEMS,
  applyFanoutAgentFlags,
  fanoutChoiceBinding,
  validateFanoutAgentChoice,
  type FanoutAgentChoice,
} from '../../../shared/fanoutPreset';
import {
  MODEL_ENV_MARKER,
  applyWorkerPermissionFlags,
  reattachModelEnvMarker,
  splitModelEnvMarker,
  workerLaunchFlags,
} from '../../../shared/workerLaunch';
import { workerLaunchCommand } from '../../../main/worktask/FanOutService';

/**
 * A preset row / caller `agents[k]` on the fan-out spawn path.
 *
 * `handleRpcMethod` cannot be imported under vitest (see
 * useRpcBridge.fanoutRole.test.ts), so this file does two things:
 *  1. runs the handler's launch chain — the same exported functions, in the
 *     order the structural test below pins — on the line main really sends;
 *  2. pins that the handler calls them in that order and re-validates the
 *     choice before anything launches.
 */
const PROMPT = '/data/worktrees/.meta/t/prompt.md';
const CWD = '/data/outputs/image/b1/1-codex-abcd1234';

function launch(choice: FanOutChoiceInput, mode: 'auto' | 'manual' = 'auto'): string {
  const main = workerLaunchCommand('claude', PROMPT, { platform: 'darwin' }).command;
  const checked = validateFanoutAgentChoice(choice, { allowUnattended: true });
  if (!checked.ok) throw new Error(checked.error);
  const binding = fanoutChoiceBinding(checked.choice);
  const { marker, command: bare } = splitModelEnvMarker(main);
  const swap = applyRoleAgent(bare, binding, { extraAgents: FANOUT_EXTRA_AGENT_STEMS });
  const bound = withRoleBinding({ initialCommand: swap.command }, binding, undefined, FANOUT_EXTRA_AGENT_STEMS);
  const flagged = applyFanoutAgentFlags(bound.initialCommand as string, checked.choice, CWD, 'darwin');
  const permitted = applyWorkerPermissionFlags(flagged, mode);
  return reattachModelEnvMarker(marker, permitted, '/bin/zsh').command;
}
type FanOutChoiceInput = FanoutAgentChoice | Record<string, unknown>;

describe('fan-out launch with an agent choice', () => {
  it('codex + model → codex --model m "$(cat …)" (plus its folder trust), no claude flags', () => {
    const cmd = launch({ agent: 'codex', model: 'gpt-5.5' });
    expect(cmd.startsWith('codex ')).toBe(true);
    expect(cmd).toContain(`--model gpt-5.5 "$(cat '${PROMPT}')"`);
    expect(cmd).toContain(`-c 'projects={"${CWD}"={trust_level="trusted"}}'`);
    // No claude-only permission flags, and the prompt is still the last argument.
    expect(cmd).not.toMatch(/--permission-mode|--allowedTools|--dangerously/);
    expect(cmd.endsWith(`"$(cat '${PROMPT}')"`)).toBe(true);
    // A pinned model drops the ANTHROPIC_MODEL marker (the flag wins).
    expect(cmd.startsWith(MODEL_ENV_MARKER)).toBe(false);
  });

  it('codex unattended puts its approval flags before the prompt', () => {
    const cmd = launch({ agent: 'codex', unattended: true });
    expect(cmd).toMatch(/^.*codex -c '[^']+' -a never -s workspace-write "\$\(cat /);
  });

  it('claude keeps the worker permission flags and the model-env marker', () => {
    const cmd = launch({ agent: 'claude' });
    expect(cmd.startsWith(MODEL_ENV_MARKER + 'claude "$(cat')).toBe(true);
    expect(cmd.endsWith(workerLaunchFlags('auto'))).toBe(true);
  });

  it('claude + model pins it and still carries the permission flags', () => {
    const cmd = launch({ agent: 'claude', model: 'opus' });
    expect(cmd.startsWith('claude --model opus "$(cat')).toBe(true);
    expect(cmd).toContain(workerLaunchFlags('auto'));
  });

  it('grok + model through the fan-out-only allow list', () => {
    const cmd = launch({ agent: 'grok', model: 'grok-4.7', unattended: true });
    expect(cmd).toBe(`grok --permission-mode bypassPermissions --model grok-4.7 "$(cat '${PROMPT}')"`);
  });

  it('gemini (a known stem) without a model gets no model flag — and is not selectable yet', () => {
    const main = workerLaunchCommand('claude', PROMPT, { platform: 'darwin' }).command;
    const { command: bare } = splitModelEnvMarker(main);
    const swap = applyRoleAgent(bare, { agent: 'gemini' });
    const bound = withRoleBinding({ initialCommand: swap.command }, { agent: 'gemini' });
    expect(bound.initialCommand).toBe(`gemini "$(cat '${PROMPT}')"`);
    expect(() => launch({ agent: 'gemini' })).toThrow(/not available for fan-out/);
  });

  it('a hostile model never reaches the line', () => {
    expect(() => launch({ agent: 'codex', model: '--dangerously-bypass-approvals-and-sandbox' })).toThrow();
    expect(() => launch({ agent: 'codex', model: 'a;b' })).toThrow();
  });
});

describe('useRpcBridge — fanout.spawnWorkspace wiring for agent choices', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const block = (() => {
    const m = src.match(/if \(method === 'fanout\.spawnWorkspace'\)[\s\S]*?\n {2}\}\n/);
    if (!m) throw new Error('fanout.spawnWorkspace handler not found');
    return m[0];
  })();
  const at = (re: RegExp): number => {
    const i = block.search(re);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('re-validates the choice against the closed table AND normalizeRoleBinding, failing the task if either disagrees', () => {
    expect(block).toMatch(/validateFanoutAgentChoice\(params\.agentChoice, \{ allowUnattended: true \}\)/);
    expect(block).toMatch(/normalizeRoleBinding\(fanoutChoiceBinding\(checked\.choice\)\)/);
    expect(block).toMatch(/return \{ error: `fanout\.spawnWorkspace: invalid agent choice/);
  });

  it('runs the chain in order: marker off → agent swap → model → CLI flags → permission flags → marker on', () => {
    const order = [
      /splitModelEnvMarker\(initialCommand\)/,
      /applyRoleAgent\(bareCommand, roleBinding, extraAgents/,
      /withRoleBinding\(seeded, roleBinding, role, extraAgents\)/,
      /applyFanoutAgentFlags\(\s*roleBoundRaw\.initialCommand,\s*agentChoice,\s*cwd,/,
      /applyWorkerPermissionFlags\(roleBound\.initialCommand, workerMode\)/,
      /reattachModelEnvMarker\(marker, bound\.initialCommand, seeded\.shell\)/,
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('fails the task (no workspace yet) when the agent swap is refused, instead of launching the default claude', () => {
    expect(at(/if \(agentChoice && !swap\.changed && commandLauncherStem\(swap\.command\) !== agentChoice\.agent\)/)).toBeLessThan(
      at(/store\.addWorkspace\(name\)/),
    );
    expect(block).toMatch(/could not launch \$\{agentChoice\.agent\} for this task/);
  });

  it('builds the codex trust override for the pane platform', () => {
    expect(block).toMatch(/window\.electronAPI\?\.platform/);
  });

  it('keeps the lineage stamp on the same pty.create call (depth-1 and caps still apply)', () => {
    expect(block).toMatch(/pty\.create\(\s*fanoutTaskOf \? \{ \.\.\.createOptions, fanoutTaskOf \} : createOptions,?\s*\)/);
  });
});

// ─── Bot engines — which agent runs a bot, and the spawn-time checks ───────
//
// `claude-sdk` (the default) runs the bot on the Claude Agent SDK with the
// user's own claude install; `acp` runs any Agent Client Protocol command;
// `claude-pty` is refused for bots in this version (the terminal brain is
// built around one embedded pane per workspace brain, not a headless bot).
//
// Bots run only on engines whose native tools are verified blocked (design
// §11 R5). In this release that is `claude-sdk`: an ACP bot (any ACP command,
// and the scripted smoke stub) starts only in an unpackaged build running on
// isolated data — the factory smoke's test instances — and is refused with
// `engine_unavailable` everywhere else (`acpEnginesAllowed`).
//
// Every spawn is checked before anything starts: the wmux MCP bundle must
// exist (a bot without its tools is refused, not started half-blind), the
// claude executable must resolve for `claude-sdk`, and an ACP command must
// be an executable file on PATH (a missing one is a clear `engine_unavailable`
// refusal, never a 30-second request timeout). The MCP child is always the
// bundled server run by wmux's own binary in Node mode, in bot mode, with the
// token handed over in a file (ClaudeSdkAdapter / AcpBrainAdapter `bot`).
// A `claude-sdk` bot signs in to Claude as Settings › Bots says (the
// subscription, or a saved API key: claudeApiKey.ts); chosen without a
// usable key, it is refused with `engine_unavailable` before it starts.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { BotBinding, BotEngine, BotProfile } from '../../shared/bot';
import { CLAUDE_EFFORT_LEVELS, type ClaudeEffort } from '../../shared/claudeModels';
import { validateBotBrainModel } from '../../shared/fanoutPreset';
import type { BrainAdapter } from '../deck/BrainAdapter';
import { ClaudeSdkAdapter } from '../deck/ClaudeSdkAdapter';
import { AcpBrainAdapter } from '../deck/AcpBrainAdapter';
import { dataSuffix } from '../../shared/constants';
import { isExecutableFile, resolveClaudeExecutable } from '../claude/resolveClaudeExecutable';
import { botRepoReadRoot } from './botRepoRead';
import { recordBotAuthSource, resolveBotClaudeAuth, type BotClaudeAuth } from './claudeApiKey';

export interface BotEngineSpawnInput {
  profile: BotProfile;
  binding: BotBinding;
  /** The bot's own working directory (created by the caller). */
  cwd: string;
  wmuxDir: string;
  /** Isolated-instance smoke: run on the scripted ACP stub. */
  acpStub?: boolean;
}

export type BotEngineSpawn =
  | { ok: true; adapter: BrainAdapter }
  | { ok: false; code: 'engine_unavailable'; message: string };

export type BotEngineFactory = (input: BotEngineSpawnInput) => BotEngineSpawn;

/** The bundled MCP server a bot's MCP child runs: packaged
 *  `resources/mcp-bundle/index.js`, dev `dist/mcp-bundle/index.js` (looked up
 *  from the app path and a few parents, so a worktree build is found). */
export function resolveBotMcpBundlePath(): string | null {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'mcp-bundle', 'index.js');
    return fs.existsSync(p) ? p : null;
  }
  let dir = app.getAppPath();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'dist', 'mcp-bundle', 'index.js');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** An executable file for `command`: itself when it is a path, else the
 *  first PATH entry (with PATHEXT on Windows) that holds one. */
export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExec: (p: string) => boolean = isExecutableFile,
): string | null {
  if (!command) return null;
  if (command.includes('/') || command.includes('\\')) {
    return path.isAbsolute(command) && isExec(command) ? command : null;
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, command + ext);
      if (isExec(p)) return p;
    }
  }
  return null;
}

function narrowEffort(effort: string | undefined): ClaudeEffort | undefined {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort ?? '') ? (effort as ClaudeEffort) : undefined;
}

/** The SDK `model` option of a bot's turn: the stored id when it passes the
 *  brain model rule and is not 'default', else none. */
function brainModelOption(model: string | undefined): { model?: string } {
  const checked = model === undefined ? null : validateBotBrainModel(model);
  return checked?.ok && checked.model.toLowerCase() !== 'default' ? { model: checked.model } : {};
}

export interface DefaultBotEngineDeps {
  bundlePath?: () => string | null;
  claudeExecutable?: () => string | null;
  resolveCommand?: (command: string) => string | null;
  /** The ACP stub script for smoke runs. */
  acpStubPath?: () => string | null;
  /** Whether ACP engines may run (default `acpEnginesAllowed`). */
  acpAllowed?: () => boolean;
  /** How a Claude (SDK) bot signs in (default `resolveBotClaudeAuth`). */
  claudeAuth?: () => BotClaudeAuth;
  /** Told the sign-in a session reported (default `recordBotAuthSource`). */
  onAuthSeen?: (apiKeySource: string) => void;
}

/** ACP bots may start: an unpackaged build on isolated data (a test
 *  instance). A released build never starts one. */
export function acpEnginesAllowed(): boolean {
  return !app.isPackaged && dataSuffix() !== '';
}

/** The engine a new bot gets from the factory's default: the default when
 *  bots may run on it here, else claude-sdk (never a default that would be
 *  refused at the bot's first turn). */
export function runnableDefaultEngine(engine: BotEngine, acpAllowed: () => boolean = acpEnginesAllowed): BotEngine {
  if (engine.kind === 'claude-sdk') return engine;
  if (engine.kind === 'acp' && acpAllowed()) return engine;
  return { kind: 'claude-sdk' };
}

export const ACP_TEST_ONLY_MESSAGE =
  'ACP engines run bots only in a test build of wmux in this version; switch this bot to Claude (SDK) in its profile';

function defaultAcpStubPath(): string | null {
  const p = path.join(app.getAppPath(), 'scripts', 'acp-stub.mjs');
  return !app.isPackaged && fs.existsSync(p) ? p : null;
}

export function createDefaultBotEngineFactory(deps: DefaultBotEngineDeps = {}): BotEngineFactory {
  const bundlePath = deps.bundlePath ?? resolveBotMcpBundlePath;
  const claudeExecutable = deps.claudeExecutable ?? resolveClaudeExecutable;
  const resolveCommand = deps.resolveCommand ?? ((c: string) => resolveOnPath(c));
  const acpStubPath = deps.acpStubPath ?? defaultAcpStubPath;
  const acpAllowed = deps.acpAllowed ?? acpEnginesAllowed;
  const claudeAuth = deps.claudeAuth ?? (() => resolveBotClaudeAuth());
  const onAuthSeen = deps.onAuthSeen ?? recordBotAuthSource;
  const refuse = (message: string): BotEngineSpawn => ({ ok: false, code: 'engine_unavailable', message });

  return (input) => {
    const bundle = bundlePath();
    if (!bundle) return refuse('the wmux MCP bundle was not found, so the bot would have no tools');
    const bot = { binding: input.binding, cwd: input.cwd, wmuxDir: input.wmuxDir };
    if (input.acpStub) {
      if (!acpAllowed()) return refuse(ACP_TEST_ONLY_MESSAGE);
      const stub = acpStubPath();
      if (!stub) return refuse('the ACP stub is not available in this build');
      return {
        ok: true,
        adapter: new AcpBrainAdapter({
          spawnSpec: { command: process.execPath, args: [stub] },
          spawnEnv: { ELECTRON_RUN_AS_NODE: '1' },
          mcpBundlePath: bundle,
          bot,
        }),
      };
    }
    const engine: BotEngine = input.profile.engine;
    switch (engine.kind) {
      case 'claude-sdk': {
        if (!claudeExecutable()) return refuse('Claude Code is not installed (no claude executable found)');
        // The adapter reads it again every turn; checked here so a bot set
        // to an API key with none saved never starts.
        const auth = claudeAuth();
        if (auth.mode === 'refused') return refuse(auth.message);
        return {
          ok: true,
          adapter: new ClaudeSdkAdapter({
            // A bot with a repository reads it (Read / Grep / Glob, decided by main).
            bot: { ...bot, repoRoot: botRepoReadRoot(input.profile), auth: claudeAuth, onAuthSeen },
            mcpBundlePath: bundle,
            // No model set (or 'default', or a stored id that fails the brain
            // model rule): pass none, so claude picks its own default and an
            // ANTHROPIC_MODEL the owner set for a gateway or Bedrock still
            // applies; `--model default` overrode it. claude then resumes a
            // conversation on the model it last ran on, so the runtime starts
            // a fresh one when the pin changes (BotRuntime session()).
            ...brainModelOption(engine.model),
            ...(narrowEffort(engine.effort) ? { effort: narrowEffort(engine.effort) } : {}),
          }),
        };
      }
      case 'acp': {
        if (!acpAllowed()) return refuse(ACP_TEST_ONLY_MESSAGE);
        const exe = resolveCommand(engine.command);
        if (!exe) return refuse(`the ACP command "${engine.command}" is not an executable on PATH`);
        return {
          ok: true,
          adapter: new AcpBrainAdapter({ spawnSpec: { command: exe, args: [...engine.args] }, mcpBundlePath: bundle, bot }),
        };
      }
      case 'claude-pty':
        return refuse('the claude-pty engine is not available for bots in this version; use claude-sdk or acp');
      default:
        return refuse('unknown engine');
    }
  };
}

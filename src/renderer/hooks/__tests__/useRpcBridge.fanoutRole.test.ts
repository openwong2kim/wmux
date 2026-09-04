import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Per-task role wiring on the fan-out spawn path.
 *
 * A fan-out task's agent + model come from the OPERATOR's role bindings, and
 * those bindings live in the renderer store — so main sends a role NAME and
 * this handler is the only place that turns it into a launch command. If the
 * wiring below is lost, every task quietly launches on the default agent while
 * the dialog (and the orchestrator's own request) says otherwise: a silent
 * wrong-model spawn, which is exactly the failure `bindingEnforcesModel` exists
 * to prevent elsewhere.
 *
 * `handleRpcMethod` is not exported and pulls in the store + window, so it
 * cannot be imported under vitest (same constraint as
 * useRpcBridge.focus.test.ts / useRpcBridge.browserClose.test.ts). The
 * behavioural assertions for the rewrite itself live in ptyCreateOptions.test.ts
 * against `withRoleBinding`; these are source-structural guards that the
 * fan-out path stays connected to it.
 */
describe('useRpcBridge — fan-out task roles', () => {
  // Normalised to LF: the block regex below anchors on `\n {2}\}\n`, which a
  // CRLF checkout turns into `\r\n  }\r\n` and never matches. That made every
  // test in this file fail on Windows while macOS and Ubuntu passed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8').replace(/\r\n/g, '\n');

  function fanoutSpawnBlock(): string {
    const m = src.match(/if \(method === 'fanout\.spawnWorkspace'\)[\s\S]*?\n {2}\}\n/);
    if (!m) {
      throw new Error(
        "the fanout.spawnWorkspace handler was not found in useRpcBridge.ts. " +
          'Update the regex if the handler layout changed.',
      );
    }
    return m[0];
  }

  it('reads the role through sanitizeOrchRole, not raw off the wire', () => {
    // The role is stamped onto pane metadata and rendered in the Fleet list, so
    // it goes through the same read-boundary neutralizer every other role entry
    // point uses (control chars collapsed, length capped).
    expect(fanoutSpawnBlock()).toMatch(/sanitizeOrchRole\(params\.role\)/);
    expect(src).toMatch(/import \{[^}]*sanitizeOrchRole[^}]*\} from '\.\.\/\.\.\/shared\/orchestratorRole'/);
  });

  it('resolves the role against the operator-owned bindings', () => {
    expect(fanoutSpawnBlock()).toMatch(/orchestratorRoleBindings\[role\]/);
  });

  it('swaps the agent BEFORE the model rewrite — both steps, in order', () => {
    // applyRoleBinding refuses a command whose launcher differs from the
    // binding's agent, so without the swap first a Reviewer→codex binding is
    // inert twice over: no agent change AND no model flag. Panel review caught
    // exactly this.
    const block = fanoutSpawnBlock();
    expect(block).toMatch(/applyRoleAgent\(bareCommand, roleBinding\)/);
    // Match the CALLS, not the prose: the comment above the swap names
    // withRoleBinding first, so a plain indexOf compares against the comment.
    expect(block.search(/applyRoleAgent\(/)).toBeLessThan(block.search(/withRoleBinding\(seeded/));
    // …and the swapped command is what gets launched, not the original.
    expect(block).toMatch(/initialCommand: swap\.command/);
    expect(src).toMatch(/import \{[^}]*applyRoleAgent[^}]*\} from '\.\.\/\.\.\/shared\/orchestratorRole'/);
  });

  it('returns the launched command so a re-fire replays the bound one', () => {
    const block = fanoutSpawnBlock();
    expect(block).toMatch(/return \{ workspaceId: newWsId, ptyId, initialCommand: launchCommand \}/);
    // …and that variable is read off the options the PTY was actually created
    // with, so the role rewrite, the marker decision and the workspace profile
    // are all already in it.
    expect(block).toMatch(/const launchCommand = createOptions\.initialCommand \?\? ''/);
    expect(block).toMatch(/pty\.create\(createOptions\)/);
  });

  it('applies the binding to the launch command via withRoleBinding', () => {
    const block = fanoutSpawnBlock();
    // Order matters: withDefaultShell must run FIRST so there is a command to
    // rewrite, and withWorkspaceProfile stays outermost so the profile's env
    // overlay is applied to whatever command survives the rewrite.
    const at = (re: RegExp): number => {
      const i = block.search(re);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(at(/withDefaultShell\(/)).toBeLessThan(at(/withRoleBinding\(seeded/));
    expect(at(/withRoleBinding\(seeded/)).toBeLessThan(at(/withWorkspaceProfile\(/));
    expect(src).toMatch(/import \{[^}]*withRoleBinding[^}]*\} from '\.\.\/utils\/ptyCreateOptions'/);
  });

  // ── F15: the model-env marker crosses this handler ─────────────────────────

  it('takes the model-env marker OFF before the role rewrite and back on after', () => {
    // Both role steps gate on the command's FIRST TOKEN. A marker in front of
    // the launcher makes the stem unrecognisable, and the binding's agent AND
    // its model are dropped without a word — the same stem-mismatch trap
    // applyRoleAgent exists to work around.
    const block = fanoutSpawnBlock();
    const at = (re: RegExp): number => {
      const i = block.search(re);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(at(/const \{ marker, command: bareCommand \} = splitModelEnvMarker\(initialCommand\)/)).toBeLessThan(
      at(/applyRoleAgent\(/),
    );
    expect(at(/withRoleBinding\(seeded/)).toBeLessThan(at(/reattachModelEnvMarker\(/));
    expect(src).toMatch(/import \{[^}]*reattachModelEnvMarker[^}]*\} from '\.\.\/\.\.\/shared\/workerLaunch'/);
  });

  it('gives the marker decision the bound command AND the pane shell', () => {
    // Those are the two things main could not see: whether the operator's role
    // binding ended up naming a model, and whether this pane's shell can even
    // run the marker (fish has no `unset`).
    expect(fanoutSpawnBlock()).toMatch(
      /reattachModelEnvMarker\(marker, bound\.initialCommand, seeded\.shell\)/,
    );
  });

  it('says out loud when the neutralisation was dropped', () => {
    // Losing it silently is how the operator's shell wins again with nobody
    // noticing — the exact failure mode this whole fix exists for.
    expect(fanoutSpawnBlock()).toMatch(/model-env marker dropped/);
  });

  it('stamps the role on the pane so it survives the first launch', () => {
    // The launch rewrite only covers the FIRST command. A re-fire, or a line the
    // orchestrator later sends into this pane, re-derives the binding from the
    // pane's role — so a spawn that rewrote the command but never stamped the
    // pane would drift back to the default model on the second turn.
    expect(fanoutSpawnBlock()).toMatch(/metadata\.setRole\(paneId, newWsId, role\)/);
  });

  it('expands roles into what they will run for the approval dialog', () => {
    // The wire preview prints role NAMES; the bindings live here. Approving
    // "[role: Reviewer]" without seeing it means another CLI, another model, or
    // extra flags would make the approved text and the executed command differ.
    const m = src.match(/if \(method === 'fanout\.requestApproval'\)[\s\S]*?\n {2}\}\n/);
    expect(m?.[0]).toMatch(/describeFanOutRoles\(params\.roles\)/);
    // Only claim a model that will actually be injected.
    const helper = src.match(/function describeFanOutRoles\([\s\S]*?\n\}/);
    expect(helper?.[0]).toMatch(/bindingEnforcesModel\(b\)/);
    expect(helper?.[0]).toMatch(/no binding/);
  });

  it('restores focus before the role write, not after', () => {
    // setRole is an IPC round-trip; awaiting it while the new workspace is
    // active drags the user's screen for every task in the fan-out.
    const block = fanoutSpawnBlock();
    expect(block.indexOf('setActiveWorkspace(previousActiveId)')).toBeLessThan(
      block.indexOf('metadata.setRole'),
    );
  });

  it('never fails the spawn over a role', () => {
    // The task is already running by then; losing the label must not roll it
    // back, and an unbound role is the operator's choice, not an error.
    const block = fanoutSpawnBlock();
    const stamp = block.match(/if \(role\) \{[\s\S]*?\n {4}\}/);
    expect(stamp?.[0]).toMatch(/try \{[\s\S]*catch/);
  });
});

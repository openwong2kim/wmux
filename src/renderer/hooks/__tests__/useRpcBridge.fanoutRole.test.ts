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
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

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

  it('applies the binding to the launch command via withRoleBinding', () => {
    const block = fanoutSpawnBlock();
    expect(block).toMatch(/withRoleBinding\(/);
    // Order matters: withDefaultShell must run FIRST so there is a command to
    // rewrite, and withWorkspaceProfile stays outermost so the profile's env
    // overlay is applied to whatever command survives the rewrite.
    expect(block).toMatch(/withWorkspaceProfile\(\s*withRoleBinding\(\s*withDefaultShell\(/);
    expect(src).toMatch(/import \{[^}]*withRoleBinding[^}]*\} from '\.\.\/utils\/ptyCreateOptions'/);
  });

  it('stamps the role on the pane so it survives the first launch', () => {
    // The launch rewrite only covers the FIRST command. A re-fire, or a line the
    // orchestrator later sends into this pane, re-derives the binding from the
    // pane's role — so a spawn that rewrote the command but never stamped the
    // pane would drift back to the default model on the second turn.
    expect(fanoutSpawnBlock()).toMatch(/metadata\.setRole\(paneId, newWsId, role\)/);
  });

  it('never fails the spawn over a role', () => {
    // The task is already running by then; losing the label must not roll it
    // back, and an unbound role is the operator's choice, not an error.
    const block = fanoutSpawnBlock();
    const stamp = block.match(/if \(role\) \{[\s\S]*?\n {4}\}/);
    expect(stamp?.[0]).toMatch(/try \{[\s\S]*catch/);
  });
});

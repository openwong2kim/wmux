import React from 'react';
import { useStore } from '../../stores';
import { isPaneAgentBusy } from '../../stores/selectors/fleet';
import { selectRemoteResumePane } from '../../stores/selectors/remoteResume';
import ResumeInfoChip from '../Pane/ResumeInfoChip';

/**
 * #1342 — the persistent resume chip for a REMOTE-terminal surface.
 *
 * The local chip (ResumeInfoChipGate) is keyed on a ptyId and gates on the
 * PTY-keyed liveness maps; a remote surface has neither. This is its twin: the
 * offer and both gate signals come from the host's own `/api/workspaces`
 * snapshot (addressed by `remote:{hostId}:{sessionId}`), and the command is
 * typed through the remote input path instead of `pty.write`.
 *
 * Two gates are preserved verbatim from the local chip:
 *   - never type into a LIVE agent — `isPaneAgentBusy` over the host's OSC 133
 *     state and its process truth, the same two authoritative tiers;
 *   - never auto-run — the command is typed with no trailing Enter.
 *
 * A third gate is remote-only: a host serving without `--allow-input` refuses
 * every write, so the chip is not offered there at all rather than rendering a
 * button whose click is silently dropped.
 */
export default function RemoteResumeChip(props: {
  hostId: string;
  sessionId: string;
  /** Live attach for the remote input path. Null while (re)attaching. */
  attachId: string | null;
  /** The host is not known to accept input — either it was started without
   *  `--allow-input`, or the probe has not answered yet. */
  readOnly: boolean;
}): React.ReactElement | null {
  const { hostId, sessionId, attachId, readOnly } = props;
  const pane = useStore((s) => selectRemoteResumePane(s, hostId, sessionId));
  const resume = pane?.resume;
  if (!resume || readOnly || !attachId) return null;
  // FAIL-CLOSED, and this is where the remote path must differ from the local
  // one. A local pane that reports neither authoritative signal still has real
  // evidence underneath — its own output stamps and its hook's turn latch — so
  // falling through to the heuristic is a judgement, not a guess. A remote pane
  // has none of that: no activity clock, no latch, nothing but what the host
  // said. With both signals absent, `isPaneAgentBusy` would decide "not busy"
  // from an empty tier 3 and type into whatever is running. So the chip
  // requires the host to have actually answered.
  if (typeof pane.commandRunning !== 'boolean' && typeof pane.agentProcessAlive !== 'boolean') {
    return null;
  }
  const busy = isPaneAgentBusy({
    activityAt: 0,
    agentClockMs: 0,
    status: pane.agentStatus,
    commandRunning: pane.commandRunning,
    agentProcessAlive: pane.agentProcessAlive,
  });
  if (busy) return null;
  return (
    <ResumeInfoChip
      // The chip's ptyId is unused on this path: `onSend` takes the command
      // instead, so nothing can fall through to a local `pty.write`.
      ptyId=""
      binding={{
        agent: resume.agent,
        sessionId: resume.sessionId,
        // The origin cwd never crosses the API (it is a path on another
        // machine); `exactOverride` carries the host's verdict in its place.
        cwd: '',
        ...(resume.permissionMode ? { permissionMode: resume.permissionMode } : {}),
        ts: 0,
      }}
      paneCwds={[]}
      exactOverride={resume.cwdMatches}
      onSend={(command) => {
        window.electronAPI?.remote?.paneWrite(attachId, command);
      }}
    />
  );
}

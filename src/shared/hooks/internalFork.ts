/** Claude Code's own forked agents (the prompt suggestion and the away recap,
 *  run after a turn's Stop) carry an `agent_id` and no `agent_type` in their
 *  hook payloads; a real subagent always carries both. The bridge skips their
 *  hooks except the permission gate, which still has to answer, so the
 *  daemon and main tell them apart with this same test. Pure. */
export function isInternalForkPayload(payload: Record<string, unknown> | undefined): boolean {
  const agentId = payload?.['agent_id'];
  const agentType = payload?.['agent_type'];
  return typeof agentId === 'string' && agentId.length > 0
    && !(typeof agentType === 'string' && agentType.length > 0);
}

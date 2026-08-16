import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

describe('agentToolbarSlice', () => {
  beforeEach(() => {
    useStore.setState({
      agentToolbarEnabled: true,
      toolbarSnippets: [],
      richDraftByPane: {},
      toolbarPopover: null,
      composeTarget: 'pane',
      composeContext: null,
      fanOutWorkspaceId: null,
      newConversationCommand: '/clear',
    });
  });

  it('toggles enabled', () => {
    useStore.getState().setAgentToolbarEnabled(false);
    expect(useStore.getState().agentToolbarEnabled).toBe(false);
  });

  it('adds, updates, removes snippets', () => {
    useStore.getState().addSnippet('Tests', 'write tests for this');
    let snips = useStore.getState().toolbarSnippets;
    expect(snips).toHaveLength(1);
    const id = snips[0].id;
    expect(snips[0]).toMatchObject({ label: 'Tests', text: 'write tests for this' });

    useStore.getState().updateSnippet(id, { text: 'updated' });
    expect(useStore.getState().toolbarSnippets[0].text).toBe('updated');

    useStore.getState().removeSnippet(id);
    expect(useStore.getState().toolbarSnippets).toHaveLength(0);
  });

  it('sets and clears per-pane rich drafts', () => {
    useStore.getState().setRichDraft('pty-1', 'hello');
    expect(useStore.getState().richDraftByPane['pty-1']).toBe('hello');
    useStore.getState().clearRichDraft('pty-1');
    expect(useStore.getState().richDraftByPane['pty-1']).toBeUndefined();
  });

  it('sets popover and new-conversation command', () => {
    useStore.getState().setToolbarPopover('rich');
    expect(useStore.getState().toolbarPopover).toBe('rich');
    useStore.getState().setNewConversationCommand('/reset');
    expect(useStore.getState().newConversationCommand).toBe('/reset');
  });

  it('openCompose resets the target to this pane', () => {
    useStore.getState().setComposeTarget('workspace');
    useStore.getState().openCompose({ paneId: 'p1', ptyId: 'pty-1' });
    expect(useStore.getState().toolbarPopover).toBe('rich');
    expect(useStore.getState().composeTarget).toBe('pane');
    expect(useStore.getState().composeContext).toEqual({ paneId: 'p1', ptyId: 'pty-1' });
  });

  it('openFanOut toggles the same workspace closed', () => {
    useStore.getState().openFanOut('ws-1', { top: 10, left: 20 });
    expect(useStore.getState().fanOutWorkspaceId).toBe('ws-1');
    useStore.getState().openFanOut('ws-1');
    expect(useStore.getState().fanOutWorkspaceId).toBeNull();
  });
});

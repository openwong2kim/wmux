import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunHistoryStore } from '../RunHistoryStore';
import type { HookAgentEventData } from '../../hooks/HookIngest';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(),'wmux-history-')); });
afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
const signal = (kind: HookAgentEventData['signal']['kind'], status: HookAgentEventData['status'], ts = 100): HookAgentEventData => ({
  source:'hook',decision:'emit',hookKind:kind,status,agent:'Claude Code',message:'Result summary',
  signal:{kind,agent:'claude',agentSessionId:'agent-1',cwd:'/repo',payload:{},ts},
});
describe('durable phone results', () => {
  it('records authoritative completed and failed results, deduplicates replay, survives restart', () => {
    const store = new RunHistoryStore(root);
    store.ingest('pane',{},signal('agent.stop','complete'));
    store.ingest('pane',{},signal('agent.stop','complete'));
    store.ingest('pane',{},signal('agent.stop_failure','error',200));
    expect(new RunHistoryStore(root).list().entries.map(x=>x.outcome)).toEqual(['failed','completed']);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root,'phone-run-history.json')).mode & 0o777).toBe(0o600);
  });
  it('never treats subagent completion, idle detector or a continuing lead as done', () => {
    const store = new RunHistoryStore(root);
    store.ingest('pane',{},signal('agent.subagent_stop','complete'));
    store.ingest('pane',{},signal('agent.stop','running'));
    store.ingest('pane',{}, {...signal('agent.stop','complete'),source:'detector'});
    expect(store.list().entries).toEqual([]);
  });
  it('retains active work across restart and marks a lost pane interrupted exactly once', () => {
    const store = new RunHistoryStore(root);
    store.ingest('pane',{},signal('agent.tool_started','running'));
    const restarted = new RunHistoryStore(root);
    restarted.interrupted('pane',200);
    restarted.interrupted('pane',300);
    restarted.interrupted('idle-shell',300);
    expect(new RunHistoryStore(root).list().entries.map(x=>x.outcome)).toEqual(['interrupted']);
  });
  it('reconciles only active panes missing after daemon recovery', () => {
    const store = new RunHistoryStore(root);
    store.ingest('gone',{},signal('agent.tool_started','running'));
    store.ingest('restored',{},signal('agent.tool_started','running'));
    const restarted = new RunHistoryStore(root);
    restarted.reconcileLiveSessions(new Set(['restored']));
    expect(restarted.list().entries.map(x=>x.sessionId)).toEqual(['gone']);
  });
  it('a pane exiting after completion does not invent an interruption', () => {
    const store = new RunHistoryStore(root);
    store.ingest('pane',{},signal('agent.activity','running'));
    store.ingest('pane',{},signal('agent.stop','complete',200));
    store.interrupted('pane',300);
    expect(store.list().entries.map(x=>x.outcome)).toEqual(['completed']);
  });
  it('surfaces persistence failure and retries without losing the result', () => {
    const store = new RunHistoryStore(root);
    fs.rmdirSync(root);
    fs.writeFileSync(root,'block writes');
    expect(() => store.ingest('pane',{},signal('agent.stop','complete'))).toThrow();
    expect(() => store.list()).toThrow();
    fs.unlinkSync(root);
    fs.mkdirSync(root);
    expect(store.list().entries).toHaveLength(1);
    expect(new RunHistoryStore(root).list().entries).toHaveLength(1);
  });
  it('recovers the last durable generation when the primary is missing', () => {
    const store = new RunHistoryStore(root);
    store.ingest('pane',{},signal('agent.stop','complete',1));
    store.ingest('pane',{},signal('agent.stop','complete',2));
    fs.unlinkSync(path.join(root,'phone-run-history.json'));
    expect(new RunHistoryStore(root).list().entries.map(x=>x.at)).toEqual([1]);
    expect(fs.existsSync(path.join(root,'phone-run-history.json'))).toBe(true);
  });
  it('pages newest first and exposes the next offset', () => {
    const store = new RunHistoryStore(root);
    for (let ts = 1; ts <= 3; ts++) store.ingest('pane',{},signal('agent.stop','complete',ts));
    expect(store.list(0,2)).toMatchObject({entries:[{at:3},{at:2}],nextOffset:2});
    expect(store.list(2,2)).toMatchObject({entries:[{at:1}],nextOffset:null});
  });
  it('excludes internal brain panes and bounds summaries', () => {
    const store = new RunHistoryStore(root);
    store.ingest('brain-test', {WMUX_ROLE:'orchestrator'},signal('agent.stop','complete'));
    store.ingest('ordinary-id', {WMUX_BRAIN_PTY:'1'},signal('agent.stop','complete'));
    expect(store.list().entries).toEqual([]);
    store.ingest('pane',{}, {...signal('agent.stop','complete'),message:'x'.repeat(900)+'\u001b[31m'});
    expect(store.list().entries[0].summary.length).toBe(600);
  });
});

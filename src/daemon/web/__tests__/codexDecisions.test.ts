import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {codexDecisionFromRequest} from '../codexDecisions';

// Shapes measured against codex-cli 0.157.1 (phone-decision PR0).
const measured = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures','codex-server-requests.json'),'utf8')) as
  {serverRequests:Record<string,{request?:{method:string;id:number;params:Record<string,unknown>}}>};
const request = (method:string) => measured.serverRequests[method]!.request!;

describe('Codex approvals a phone may answer',()=>{
  it('reads a command approval: its reason, its command', () => {
    const r = request('item/commandExecution/requestApproval');
    expect(codexDecisionFromRequest(r)).toEqual({method:r.method,threadId:r.params.threadId,
      question:'Create out.txt in the project?',toolName:'command',summary:"/bin/zsh -lc 'touch out.txt'"});
  });
  it('reads a file-change approval, which carries no reason, root or choice list', () => {
    const r = request('item/fileChange/requestApproval');
    expect(codexDecisionFromRequest(r)).toEqual({method:r.method,threadId:r.params.threadId,
      question:'Allow these file changes?',toolName:'file change'});
  });
  it('leaves every other measured request to the terminal', () => {
    const others = Object.entries(measured.serverRequests)
      .filter(([method,entry])=>entry.request && !method.endsWith('/requestApproval'));
    expect(others.length).toBeGreaterThan(0);
    for (const [,entry] of others) expect(codexDecisionFromRequest(entry.request)).toBeUndefined();
    expect(codexDecisionFromRequest({...request('item/commandExecution/requestApproval'),method:'execCommandApproval'})).toBeUndefined();
  });
  it('needs both accept and cancel in the request\'s own choice list, a thread and a command', () => {
    const r = request('item/commandExecution/requestApproval');
    const with_ = (params:Record<string,unknown>) => codexDecisionFromRequest({...r,params:{...r.params,...params}});
    expect(with_({availableDecisions:['accept',{acceptWithExecpolicyAmendment:{}}]})).toBeUndefined();
    expect(with_({availableDecisions:['acceptForSession','cancel']})).toBeUndefined();
    expect(with_({availableDecisions:'accept,cancel'})).toBeUndefined();
    expect(with_({threadId:undefined})).toBeUndefined();
    expect(with_({command:''})).toBeUndefined();
    expect(codexDecisionFromRequest(null)).toBeUndefined();
    expect(codexDecisionFromRequest([r])).toBeUndefined();
  });
});

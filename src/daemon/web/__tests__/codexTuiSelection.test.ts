import {describe,expect,it} from 'vitest';
import {CodexTuiSelectionTracker} from '../codexTuiSelection';
const a='01234567-89ab-4cde-8123-456789abcdef';
const b='11234567-89ab-4cde-8123-456789abcdef';
const response=(id:number,threadId=a)=>({id,result:{thread:{id:threadId,cwd:'/repo',sessionId:'not-the-thread',preview:'private'}}});
describe('owned TUI selection attribution',()=>{
  it('binds only correlated replies and drops old selection while switching',()=>{
    const tracker=new CodexTuiSelectionTracker();
    tracker.fromServer(response(1));expect(tracker.current()).toBeUndefined();
    tracker.fromTui({id:1,method:'thread/start',params:{}});tracker.fromServer(response(1));
    expect(tracker.current()).toEqual({threadId:a,cwd:'/repo',generation:1});
    tracker.fromTui({id:2,method:'thread/start',params:{}});expect(tracker.current()).toBeUndefined();
    tracker.fromServer(response(1));expect(tracker.current()).toBeUndefined();
    tracker.fromServer(response(2,b));expect(tracker.current()?.threadId).toBe(b);
    tracker.fromTui({id:3,method:'thread/unsubscribe',params:{threadId:a}});
    expect(tracker.current()?.threadId).toBe(b);
  });
  it('ignores superseded requests and notifications that reuse an ID',()=>{
    const tracker=new CodexTuiSelectionTracker();
    tracker.fromTui({id:1,method:'thread/start'});tracker.fromTui({id:2,method:'thread/resume',params:{threadId:b}});
    tracker.fromServer(response(1));tracker.fromServer({...response(2),method:'thread/started'});
    expect(tracker.current()).toBeUndefined();
    tracker.fromServer(response(2,b));expect(tracker.current()?.threadId).toBe(b);
  });
  it.each(['error','expired','malformed','closed','fork','unsubscribe'])('does not restore a binding after %s',failure=>{
    let now=0;const tracker=new CodexTuiSelectionTracker(()=>now,10);
    tracker.fromTui({id:1,method:'thread/start'});
    if(failure==='expired')now=11;
    if(failure==='closed')tracker.close();
    if(failure==='fork')tracker.fromTui({id:2,method:'thread/fork'});
    if(failure==='unsubscribe')tracker.fromTui({id:2,method:'thread/unsubscribe',params:{threadId:a}});
    tracker.fromServer(failure==='error'?{id:1,error:{message:'private'}}:failure==='malformed'?{id:1,result:{thread:{id:a,cwd:'relative'}}}:response(1));
    expect(tracker.current()).toBeUndefined();
  });
  it('retires duplicate outstanding IDs and never resurrects after close',()=>{
    const tracker=new CodexTuiSelectionTracker();
    tracker.fromTui({id:1,method:'thread/start'});tracker.fromTui({id:1,method:'thread/start'});
    tracker.fromServer(response(1));tracker.fromTui({id:2,method:'thread/start'});tracker.fromServer(response(2));
    expect(tracker.current()).toBeUndefined();
  });
});


it.each(['system', 'thread_title'])('keeps the foreground selection while an automatic-title thread starts and closes (%s)',source=>{
  const tracker=new CodexTuiSelectionTracker();
  tracker.fromTui({id:1,method:'thread/start',params:{ephemeral:false,threadSource:'user'}});
  tracker.fromServer(response(1));
  const selected=tracker.current();
  tracker.fromTui({id:2,method:'thread/start',params:{ephemeral:true,threadSource:source}});
  expect(tracker.current()).toEqual(selected);
  tracker.fromServer(response(2,b));
  tracker.fromTui({id:3,method:'turn/start',params:{threadId:b}});
  tracker.fromTui({id:4,method:'thread/unsubscribe',params:{threadId:b}});
  tracker.fromServer({method:'thread/closed',params:{threadId:b}});
  expect(tracker.current()).toEqual(selected);
});

it('does not let a system thread response claim a pending foreground request ID',()=>{
  const tracker=new CodexTuiSelectionTracker();
  tracker.fromTui({id:1,method:'thread/start',params:{ephemeral:false,threadSource:'user'}});
  tracker.fromTui({id:1,method:'thread/start',params:{ephemeral:true,threadSource:'system'}});
  tracker.fromServer(response(1,b));
  expect(tracker.current()).toBeUndefined();
});

it('recovers after a request whose reply never arrives',()=>{
  let now=0;const tracker=new CodexTuiSelectionTracker(()=>now,10);
  tracker.fromTui({id:1,method:'thread/start'});
  expect(tracker.current()).toBeUndefined();
  now=11; // the reply is now past its deadline and would be discarded anyway
  // A retry reusing the same ID must not read the dead pending as a duplicate
  // outstanding request and retire the tracker for the rest of the connection.
  tracker.fromTui({id:1,method:'thread/start'});
  tracker.fromServer(response(1));
  expect(tracker.current()).toEqual({threadId:a,cwd:'/repo',generation:2});
});

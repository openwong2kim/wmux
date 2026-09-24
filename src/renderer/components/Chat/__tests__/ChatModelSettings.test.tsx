// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatModelSettings} from '../ChatModelSettings';
vi.mock('../../../hooks/useT',()=>({useT:()=> (key:string)=>key}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);HTMLDialogElement.prototype.showModal=vi.fn();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const value={model:'a',effort:'low',busy:false,revision:'scope.revision',models:[{model:'a',efforts:['low','high'],defaultEffort:'low'},{model:'b',efforts:['medium'],defaultEffort:'medium'}]};
describe('model controls for the existing native session',()=>{
  it('reads on open, applies only on explicit click, and uses the returned revision',async()=>{
    const settings=vi.fn(async()=>({ok:true,settings:value}));vi.stubGlobal('electronAPI',{chat:{settings}});const close=vi.fn();
    await act(async()=>root.render(<ChatModelSettings ptyId="pty" onClose={close} onTerminal={()=>undefined}/>));
    expect(settings).toHaveBeenCalledExactlyOnceWith({ptyId:'pty'});
    await act(async()=>{const select=host.querySelector('select')!;select.value='b';select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(settings).toHaveBeenCalledTimes(1);
    await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='chat.applyModel')!.click());
    expect(settings).toHaveBeenLastCalledWith({ptyId:'pty',choice:{model:'b',effort:'medium',expectedRevision:'scope.revision'}});expect(close).toHaveBeenCalled();
  });
  it('retains an unconfirmed result without automatically replaying the mutation',async()=>{
    const settings=vi.fn().mockResolvedValueOnce({ok:true,settings:value}).mockResolvedValueOnce({ok:false,error:'unconfirmed'});vi.stubGlobal('electronAPI',{chat:{settings}});
    await act(async()=>root.render(<ChatModelSettings ptyId="pty" onClose={()=>undefined} onTerminal={()=>undefined}/>));
    await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='chat.applyModel')!.click());
    expect(host.textContent).toContain('chat.modelError.unconfirmed');expect(settings).toHaveBeenCalledTimes(2);
    expect([...host.querySelectorAll('button')].find(b=>b.textContent==='chat.applyModel')!.disabled).toBe(true);
  });
});

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {sendRequest,setWorkspaceToken} from '../client';
import {resolveSelfContext,getParentPidDefault} from '../identity';
import {resolveCodexManagedExecutable} from '../../shared/codexManagedExecutable';

/** Foreground native TUI. The child gets a per-launch bearer; neither its value
 * nor the relay response is printed or written to disk. */
export async function handleCodex(args:string[]):Promise<void> {
  if (process.platform !== 'win32') throw new Error('wmux codex currently supports native Windows terminals.');
  if (args.some(arg=>arg === '--no-daemon' || /^--remote(?:=|$)/.test(arg) || /^--remote-auth-token-env(?:=|$)/.test(arg))) {
    throw new Error('wmux codex owns its pane connection. Use native codex for --no-daemon or a custom --remote.');
  }
  const self = await resolveSelfContext({sendRequest,env:process.env,ppid:process.ppid,
    callerPid:process.pid,getParentPid:getParentPidDefault});
  if (!self.ptyId || !self.workspaceToken) throw new Error('Run wmux codex directly in a wmux terminal pane.');
  setWorkspaceToken(self.workspaceToken);
  const codeHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'));
  // Outlive main's 100s deadline and the runtime's lock/version/start/probe bounds.
  const response = await sendRequest('codex.relay.prepare',{codeHome},110_000);
  if (!response.ok) throw new Error(response.error);
  const lease = response.result as {url?:unknown;authToken?:unknown;leaseId?:unknown};
  if (typeof lease?.leaseId !== 'string') throw new Error('wmux returned no Codex pane lease.');
  try {
    if (typeof lease.url !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(lease.url) ||
        typeof lease.authToken !== 'string' || !/^[a-f0-9]{64}$/.test(lease.authToken)) throw new Error('Invalid Codex pane connection.');
    const executable = resolveCodexManagedExecutable(codeHome);
    const tokenName = `WMUX_CODEX_RELAY_${randomBytes(8).toString('hex').toUpperCase()}`;
    // --cd keeps a TUI in the caller's directory rather than the daemon's cwd.
    const hasCwd = args.some(arg=>arg === '-C' || /^--cd(?:=|$)/.test(arg) || /^-C./.test(arg));
    const launch = ['--remote',lease.url,'--remote-auth-token-env',tokenName,...(hasCwd ? [] : ['--cd',process.cwd()]),...args];
    const code = await new Promise<number>((resolve,reject)=>{
      const child = spawn(executable,launch,{stdio:'inherit',env:{...process.env,CODEX_HOME:codeHome,[tokenName]:lease.authToken as string}});
      child.once('error',reject);
      child.once('exit',(code)=>resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    await sendRequest('codex.relay.close',{leaseId:lease.leaseId}).catch(()=>undefined);
  }
}

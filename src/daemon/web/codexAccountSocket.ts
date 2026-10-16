import {spawn, execFile} from 'node:child_process';
import {Duplex} from 'node:stream';
import path from 'node:path';
import WebSocket from 'ws';
import {resolveCodexManagedExecutable} from '../../shared/codexManagedExecutable';

/** A Windows drive prefix is not ws+unix's separator; no other colon is valid. */
export function validCodexAccountPath(value:string):boolean {
  const rest = process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(value) ? value.slice(2) : value;
  return path.isAbsolute(value) && !value.includes('\0') && !rest.includes(':');
}

/** Native Codex bridges Windows AF_UNIX, which Node's Windows net cannot dial.
 * The proxy carries raw HTTP/WebSocket bytes, not line-delimited JSON. */
export function openCodexAccountSocket(socketPath:string, options:WebSocket.ClientOptions):WebSocket {
  if (process.platform !== 'win32') return new WebSocket(`ws+unix://${socketPath}:/`,options);
  const codeHome = path.dirname(path.dirname(socketPath));
  const executable = resolveCodexManagedExecutable(codeHome);
  const child = spawn(executable,['app-server','proxy','--sock',socketPath],{
    env:{...process.env,CODEX_HOME:codeHome},stdio:['pipe','pipe','pipe'],windowsHide:true,
  });
  child.stderr.resume();
  const stream = Duplex.from({readable:child.stdout,writable:child.stdin});
  let timeout:ReturnType<typeof setTimeout> | undefined;
  // Preserve the HTTP handshake deadline on this pipe-backed stream. The
  // native proxy owns TCP/socket tuning, but a no-op timeout would hang dials.
  const connection = Object.assign(stream,{
    setTimeout:(ms:number,callback?:()=>void)=>{
      if (timeout) clearTimeout(timeout);
      if (callback) stream.once('timeout',callback);
      if (ms > 0) timeout = setTimeout(()=>stream.emit('timeout'),ms);
      return stream;
    },
    setNoDelay:()=>stream,setKeepAlive:()=>stream,
  });
  const socket = new WebSocket('ws://localhost/',{...options,createConnection:()=>connection});
  const cleanup = () => {if (timeout) clearTimeout(timeout);stream.destroy();child.kill();};
  socket.once('close',cleanup);
  socket.once('error',cleanup);
  child.once('error',error=>stream.destroy(error));
  child.once('exit',()=>stream.destroy());
  return socket;
}

/** Windows AF_UNIX reparse points reject Node lstat (EACCES). PowerShell's
 * filesystem metadata works without opening the socket or following a thread. */
export async function windowsCodexSocketIdentity(socketPath:string):Promise<string> {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>{
    execFile(shell,['-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; $s=Get-Item -LiteralPath $env:WMUX_CODEX_SOCKET_METADATA; if ($s.PSIsContainer) { throw 'Invalid socket' }; [Console]::Write([string]$s.CreationTimeUtc.Ticks + ':' + [string]$s.LastWriteTimeUtc.Ticks)"],
    {env:{...process.env,WMUX_CODEX_SOCKET_METADATA:socketPath},windowsHide:true,timeout:5000,maxBuffer:4096},(error,stdout)=>{
      const value = stdout.trim();
      if (error || !/^\d+:\d+$/.test(value)) reject(new Error('Codex account socket unavailable'));
      else resolve(value);
    });
  });
}

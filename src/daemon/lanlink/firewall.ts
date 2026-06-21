// === LanLink Windows firewall control (PR-4, C15) ===
//
// On enable+listen: an idempotent delete-then-add of two stable-named rules — a
// Private-profile ALLOW and an explicit Public/Domain BLOCK. In Windows Firewall
// a BLOCK rule takes precedence over an ALLOW, so a stray pre-existing Public
// allow cannot win — the LAN port is reachable only on networks Windows marks
// Private. Best-effort (needs the firewall service / sufficient rights); the
// caller also refuses to listen on a Public-category NIC where it can tell, and
// the pairing window further bounds exposure.
//
// win32-only; a no-op elsewhere. Imports node:child_process/os/path only.

import { execFile } from 'node:child_process';
import path from 'node:path';

const PRIVATE_RULE = 'wmux LanLink (Private)';
const PUBLIC_DENY_RULE = 'wmux LanLink (Public deny)';

function netshPath(): string {
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'netsh.exe');
}

function run(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // timeout so a hung netsh.exe cannot wedge the firewall op chain forever.
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err) => {
      if (err) {
        console.warn(`[lanlink-firewall] ${path.basename(file)} ${args.slice(0, 4).join(' ')} ... failed:`, err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/** Apply the Private ALLOW + Public/Domain BLOCK rules (idempotent). win32-only. */
export async function applyLanLinkFirewall(port: number, exe: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const netsh = netshPath();
  // delete-then-add so a port/exe change leaves no stale rule.
  await run(netsh, ['advfirewall', 'firewall', 'delete', 'rule', `name=${PRIVATE_RULE}`]);
  await run(netsh, ['advfirewall', 'firewall', 'delete', 'rule', `name=${PUBLIC_DENY_RULE}`]);
  await run(netsh, [
    'advfirewall', 'firewall', 'add', 'rule', `name=${PRIVATE_RULE}`,
    'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=private', `program=${exe}`, 'enable=yes',
  ]);
  // The BLOCK is the rule that gates exposure (block precedence). If it fails, the
  // caller's Public-category refusal + the pairing window are the remaining gates.
  const denyOk = await run(netsh, [
    'advfirewall', 'firewall', 'add', 'rule', `name=${PUBLIC_DENY_RULE}`,
    'dir=in', 'action=block', 'protocol=TCP', `localport=${port}`, 'profile=public,domain', `program=${exe}`, 'enable=yes',
  ]);
  if (!denyOk) {
    console.warn('[lanlink-firewall] Public/Domain BLOCK rule could not be applied — relying on Public-category refusal + pairing window');
  }
}

/** Remove both LanLink firewall rules (idempotent). win32-only. */
export async function removeLanLinkFirewall(): Promise<void> {
  if (process.platform !== 'win32') return;
  const netsh = netshPath();
  await run(netsh, ['advfirewall', 'firewall', 'delete', 'rule', `name=${PRIVATE_RULE}`]);
  await run(netsh, ['advfirewall', 'firewall', 'delete', 'rule', `name=${PUBLIC_DENY_RULE}`]);
}

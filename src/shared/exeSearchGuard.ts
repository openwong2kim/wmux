// Side-effect module: import it FIRST in every process entry that spawns
// tools (daemon, Electron main, MCP server/broker, CLI). ES imports are
// hoisted, so a call placed after an entry's import block would run after
// every imported module has already been evaluated; a leading side-effect
// import runs before them. See exeSearch.ts for what this turns off and why.
import { applyExeSearchGuard } from './exeSearch';

applyExeSearchGuard();

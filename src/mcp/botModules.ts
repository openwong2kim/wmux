// The factory's bot tool modules, imported once by src/mcp/index.ts. Each
// file registers its tools with registerToolModule (src/mcp/toolModules.ts)
// at import time; a bot surface tool none of them registers is served by the
// not_implemented placeholder.
import './facts';
import './factory';
import './factoryTools';
import './botApprovals';
import './botJob';
import './botRoutines';
import './botSkills';
import './botWorkers';
import './factorySecrets';

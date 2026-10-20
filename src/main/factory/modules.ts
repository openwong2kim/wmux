// The factory's main-process modules, imported once by main/index.ts. Each
// file registers itself with registerFactoryRpcModule (./factoryHost.ts) at
// import time; a factory RPC method none of them registers answers
// not_implemented. Modules start in registration order, which is the order
// of first import: the fact log and the bot runtime start before the trigger
// engine (which factoryWiring imports, so it registers just before it). The
// wiring module's register points every module's ports at the running
// instances, and every register runs before any start. The secret store
// starts first, so its values are redacted from everything the others write.
import '../pipe/handlers/botSecret.rpc';
import '../pipe/handlers/connector.rpc';
import '../pipe/handlers/fact.rpc';
import '../pipe/handlers/bot.rpc';
import './factoryWiring';
import './triggerEngine';
import './wakeTaintModule';
import '../pipe/handlers/room.rpc';
import '../pipe/handlers/group.rpc';
import '../pipe/handlers/handoff.rpc';
import './roles';
import './mergeLaneHost';
import './approvalsModule';
import '../pipe/handlers/skill.rpc';
import '../pipe/handlers/routine.rpc';
import '../pipe/handlers/workerResume.rpc';
import '../pipe/handlers/workerMessage.rpc';
import './botWorkflowModule';
import '../pipe/handlers/memory.rpc';

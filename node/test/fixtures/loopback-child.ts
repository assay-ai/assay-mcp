// A plain Node script for node/test/oauth-flow.test.ts: it awaits the loopback result with
// nothing else keeping the event loop alive (no IPC, no stdin), as a terminal `login` would.
// argv: <state>. Prints "port N", then "result {...}" once the callback arrives.
import { startLoopback } from "../../src/oauth/loopback.js";

const lb = await startLoopback({ state: process.argv[2]! });
process.stdout.write(`port ${lb.port}\n`);
const result = await lb.result;
process.stdout.write(`result ${JSON.stringify(result)}\n`);

import { main } from "./cli.js";
import { crashLine, EXIT_CRASH, installCrashHandlers } from "./log/crash.js";
import { exitProcess, keychainProbeTimedOut } from "./profile/probe-state.js";

installCrashHandlers();

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // A keychain read stuck on an unlock prompt would keep the process alive.
    if (keychainProbeTimedOut()) exitProcess(code);
  },
  (err: unknown) => {
    process.stderr.write(`${crashLine(err)}\n`);
    process.exitCode = EXIT_CRASH;
  },
);

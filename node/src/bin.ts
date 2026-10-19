import { main } from "./cli.js";
import { crashLine, EXIT_CRASH, installCrashHandlers } from "./log/crash.js";

installCrashHandlers();

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${crashLine(err)}\n`);
    process.exitCode = EXIT_CRASH;
  },
);

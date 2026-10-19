import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`assay-mcp: ${err instanceof Error ? err.message : "unexpected error"}\n`);
    process.exitCode = 1;
  },
);

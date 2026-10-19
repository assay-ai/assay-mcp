// A child process for node/test/lock.test.ts. Bundled with esbuild by the test and forked.
// argv: <dir> <profile> <mode> [iterations] [logFile]
import { appendFileSync, closeSync, constants, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../src/profile/lock.js";

const [dir, name, mode, iterArg, logFile] = process.argv.slice(2) as [string, string, string, string?, string?];
const profile = { dir, name };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function contend(iterations: number): Promise<void> {
  const sentinel = join(dir, "inside");
  for (let i = 0; i < iterations; i++) {
    await withLock(
      profile,
      async () => {
        let fd: number;
        try {
          fd = openSync(sentinel, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        } catch {
          appendFileSync(logFile!, `OVERLAP ${process.pid} ${i}\n`);
          return;
        }
        closeSync(fd);
        appendFileSync(logFile!, `enter ${process.pid} ${i}\n`);
        await sleep(1 + Math.floor(Math.random() * 3));
        rmSync(sentinel);
        appendFileSync(logFile!, `exit ${process.pid} ${i}\n`);
      },
      { timeoutMs: 60_000 },
    );
    await sleep(Math.floor(Math.random() * 8));
  }
}

async function hold(): Promise<void> {
  await withLock(profile, async () => {
    process.send?.("acquired");
    await new Promise<void>((resolve) => process.on("message", (m) => m === "release" && resolve()));
  });
  process.send?.("released");
}

if (mode === "contend") {
  contend(Number(iterArg)).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(String(err));
      process.exit(3);
    },
  );
} else if (mode === "hold") {
  hold().then(() => process.exit(0));
}

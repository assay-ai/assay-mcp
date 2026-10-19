import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crashLine, installCrashHandlers } from "../src/log/crash.js";

const TOKEN = "assay_at_Q7xK2mP9vR4tY8wZ1nB5cD3fG6hJ0kL";
const KEY = `0x${"4f3e2d1c0b0a0918".repeat(4)}`;

describe("crashLine", () => {
  it("prints name: message only, redacted and escaped", () => {
    const err = new Error(`refresh failed ${TOKEN} \u001b[31m`, { cause: new Error(KEY) });
    const line = crashLine(err);
    expect(line).toBe("assay-mcp: Error: refresh failed [redacted] \\u001b[31m");
    expect(crashLine("a string with " + TOKEN)).toBe("assay-mcp: unexpected error");
  });

  it("handlers write one line to stderr and exit 1", () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const lines: string[] = [];
    const exits: number[] = [];
    installCrashHandlers(
      {
        on: (event, fn) => (listeners[event] = fn),
        exit: ((code: number) => void exits.push(code)) as (code: number) => never,
      },
      (l) => lines.push(l),
    );
    listeners.uncaughtException!(new Error(TOKEN));
    listeners.unhandledRejection!(new Error(KEY));
    expect(exits).toEqual([1, 1]);
    expect(lines).toEqual(["assay-mcp: Error: [redacted]\n", "assay-mcp: Error: [redacted]\n"]);
  });
});

describe("a crashing process", () => {
  let dir: string;
  const scripts: Record<string, string> = {
    uncaught: `setTimeout(() => { throw new Error("boom ${TOKEN}", { cause: new Error("${KEY}") }); }, 0);`,
    rejection: `Promise.reject(new TypeError("fetch failed ${KEY}"));`,
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "assay-mcp-crash-"));
    for (const [name, body] of Object.entries(scripts)) {
      await build({
        stdin: {
          contents: `import { installCrashHandlers } from ${JSON.stringify(resolve(__dirname, "../src/log/crash.ts"))};\ninstallCrashHandlers();\n${body}\n`,
          resolveDir: dir,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: join(dir, `${name}.mjs`),
        logLevel: "silent",
      });
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(Object.keys(scripts))("%s: stdout empty, stderr one redacted line, exit 1", (name) => {
    const r = spawnSync(process.execPath, [join(dir, `${name}.mjs`)], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/^assay-mcp: (Error|TypeError): /);
    expect(r.stderr).not.toContain(TOKEN.slice(-12));
    expect(r.stderr).not.toContain(KEY.slice(-12));
    expect(r.stderr).not.toMatch(/\s+at /);
  });
});

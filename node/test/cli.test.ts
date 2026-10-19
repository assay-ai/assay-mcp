import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, main, resolve } from "../src/cli.js";
import { VERSION } from "../src/version.js";

const COMMAND_NAMES = [
  "serve", "add", "list", "remove", "login", "logout", "status",
  "enable-paid", "limits", "allow-paid", "disallow-paid", "dev-allow", "settings", "doctor",
];

/** Commands that are no longer stubs. */
const IMPLEMENTED = [
  "add", "list", "remove", "login", "logout", "status", "enable-paid", "limits",
  "allow-paid", "disallow-paid", "dev-allow", "settings", "doctor",
];

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  return { out, err };
}

describe("resolve", () => {
  it("defaults to serve with no command or a leading flag", () => {
    expect(resolve([])).toEqual({ kind: "command", name: "serve", args: [] });
    expect(resolve(["--url", "/c/weather"])).toEqual({ kind: "command", name: "serve", args: ["--url", "/c/weather"] });
  });

  it("maps two-word dev allow", () => {
    expect(resolve(["dev", "allow", "http://localhost:3200"])).toEqual({ kind: "command", name: "dev-allow", args: ["http://localhost:3200"] });
    expect(resolve(["dev"]).kind).toBe("usage-error");
    expect(resolve(["dev-allow"]).kind).toBe("usage-error");
  });

  it("refuses unknown commands and prototype keys", () => {
    expect(resolve(["bogus"]).kind).toBe("usage-error");
    expect(resolve(["toString"]).kind).toBe("usage-error");
  });

  it("has every command of the spec", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...COMMAND_NAMES].sort());
  });
});

describe("main", () => {
  it("prints the version on stdout", async () => {
    const { out } = capture();
    expect(await main(["--version"])).toBe(0);
    expect(out.join("")).toBe(`${VERSION}\n`);
  });

  it("exits 2 with usage on stderr for an unknown command", async () => {
    const { out, err } = capture();
    expect(await main(["bogus"])).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("Usage:");
  });

  it.each(COMMAND_NAMES.filter((n) => !IMPLEMENTED.includes(n)))("stub %s exits 2 and writes nothing to stdout", async (name) => {
    const { out, err } = capture();
    const argv = name === "dev-allow" ? ["dev", "allow"] : [name];
    expect(await main(argv)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("not implemented yet");
  });
});


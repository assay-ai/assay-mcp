import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInDeployments } from "../src/deployments.js";
import { LOG_FILE_HEADER, LogFileError, openLogFile, type LogFile } from "../src/log/log-file.js";
import { createLogger, DEFAULT_LOG_LEVEL, escapeControl, formatLine, isSecretFieldName, parseLogLevel, type Logger } from "../src/log/logger.js";
import { redact } from "../src/log/redact.js";
import { pinnedFetch } from "../src/net/fetch.js";
import { resolveDeployment } from "../src/profile/deployments.js";

const POSIX = process.platform !== "win32";

/** Test-only values shaped like each secret type. None is a real credential. */
const SECRETS = {
  accessToken: "assay_at_Q7xK2mP9vR4tY8wZ1nB5cD3fG6hJ0kL",
  refreshToken: "assay_rt_Z9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF",
  authCode: "assay_ac_M4nB6vC8xZ2aS4dF6gH8jK0lQ2wE4rT",
  apiKey: "assay_sk_live_P3oI5uY7tR9eW1qA3sD5fG7hJ9kL1zX",
  privateKey: `0x${"4f3e2d1c0b0a0918".repeat(4)}`,
  signature: `0x${"9a8b7c6d5e4f3a2b1c".repeat(7)}${"0d1e2f3a"}`.slice(0, 132),
  bareKey: "7e6d5c4b3a291807".repeat(4),
};
/** A distinctive tail of each secret: none may appear in any output. */
const TAILS = Object.values(SECRETS).map((s) => s.slice(-14));

function assertClean(text: string): void {
  for (const tail of TAILS) expect(text).not.toContain(tail);
  for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
  expect(text).not.toMatch(/assay_(at|rt|ac|sk_live)_[A-Za-z0-9_-]+/);
  expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-log-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  it("replaces each pattern of spec §7.13", () => {
    expect(SECRETS.signature).toMatch(/^0x[0-9a-f]{130}$/);
    for (const s of Object.values(SECRETS)) expect(redact(`x ${s} y`)).toBe("x [redacted] y");
  });

  it("never leaves a readable tail of a longer hex run", () => {
    const long = `0x${"ab".repeat(80)}`;
    expect(redact(long)).toBe("[redacted]");
  });

  it("keeps addresses, short hashes and credential prefixes", () => {
    const address = "0x1D2625efD87c2fc10b8563f3F0890072845Fcf41";
    expect(redact(`payer=${address} id=3f2a1b9c`)).toBe(`payer=${address} id=3f2a1b9c`);
  });

  it("redacts an Authorization header in any scheme, and a bare bearer value", () => {
    expect(redact("Authorization: Bearer opaque.value-123")).toBe("Authorization: [redacted]");
    expect(redact("authorization: Basic dXNlcjpwYXNz next")).toBe("authorization: [redacted] next");
    expect(redact('{"Proxy-Authorization":"Basic dXNlcjpwYXNz"}')).not.toContain("dXNlcjpwYXNz");
    expect(redact("sent Bearer opaque.value-123")).toBe("sent Bearer [redacted]");
  });

  it("closes the probed gaps: 0X prefix, hex glued to letters, query-string secrets", () => {
    const hex = "4f3e2d1c0b0a0918".repeat(4);
    expect(redact(`k=0X${hex}`)).toBe("k=[redacted]");
    expect(redact(`k=0X${hex.toUpperCase()}`)).toBe("k=[redacted]");
    expect(redact(`pk${hex}`)).toBe("pk[redacted]");
    expect(redact(`${hex}zz`)).toBe("[redacted]zz");
    for (const param of ["request", "code", "code_verifier", "state", "refresh_token", "access_token", "rid", "token"]) {
      const out = redact(`https://mcp.example.test/continue?x=1&${param}=Zx9kQ2opaque-Value_1&y=2`);
      expect(out, param).toBe(`https://mcp.example.test/continue?x=1&${param}=[redacted]&y=2`);
    }
    expect(redact("cb#state=Zx9kQ2&code=Pq7")).toBe("cb#state=[redacted]&code=[redacted]");
  });
});

describe("redact: N2 gaps", () => {
  const SECRET_PARAMS = ["code_verifier", "refresh_token", "code", "request", "state", "access_token"];

  it("redacts a secret param at the very start of a form body", () => {
    for (const p of SECRET_PARAMS) {
      expect(redact(`${p}=Zx9kQ2opaque-Value_1&grant_type=x`), p).toBe(`${p}=[redacted]&grant_type=x`);
    }
  });

  it("pins case-insensitive query redaction", () => {
    expect(redact("https://mcp.example.test/cb?CODE=Zx9kQ2&State=Pq7opaque&Code_Verifier=Aa1")).toBe(
      "https://mcp.example.test/cb?CODE=[redacted]&State=[redacted]&Code_Verifier=[redacted]",
    );
  });

  it("redacts a bare Basic credential but not prose", () => {
    expect(redact("sent Basic dXNlcjpwYXNz next")).toBe("sent Basic [redacted] next");
    expect(redact("sent Basic dXNlcjpwYXNzMTIz== next")).toBe("sent Basic [redacted] next");
    expect(redact("a Basic Configuration step")).toBe("a Basic Configuration step");
  });

  it("redacts secret keys inside JSON text, quoted or escaped", () => {
    for (const k of SECRET_PARAMS) {
      expect(redact(`{"${k}":"Zx9kQ2opaque","n":1}`), k).toBe(`{"${k}":"[redacted]","n":1}`);
      expect(redact(`body: "{\\"${k}\\": \\"Zx9kQ2opaque\\"}"`), k).not.toContain("Zx9kQ2opaque");
    }
  });

  it("keeps ordinary prose and transaction hashes", () => {
    const tx = `0x${"ab12".repeat(16)}`;
    expect(redact("the code is fine and the state of the request: ok")).toBe("the code is fine and the state of the request: ok");
    expect(redact(`tx ${tx}`)).toBe("tx [redacted]");
  });
});

describe("logger", () => {
  it("defaults to warn and parses levels", () => {
    expect(DEFAULT_LOG_LEVEL).toBe("warn");
    const lines: string[] = [];
    const log = createLogger({ stderr: (l) => lines.push(l) });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.split(" ")[1])).toEqual(["warn", "error"]);
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("trace")).toBeNull();
  });

  it("formats `ts level component message key=value` in UTC", () => {
    const line = formatLine(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "warn", "proxy", "tool call", {
      tool: "get_weather",
      ms: 12,
      status: 200,
      note: "has space",
    });
    expect(line).toBe('2026-01-02T03:04:05.000Z warn proxy tool call tool=get_weather ms=12 status=200 note="has space"');
  });

  it('logs "\\u001b[31m" escaped', () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", stderr: (l) => lines.push(l) });
    log.warn("colour \u001b[31m red", { v: "a\u001b[31mb", nl: "x\ny\rz", sep: "p q" });
    const out = lines.join("");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\r");
    expect(out).not.toContain(" ");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).toContain("colour \\u001b[31m red");
    expect(out).toContain("v=a\\u001b[31mb");
    expect(out).toContain("nl=x\\u000ay\\u000dz");
    expect(escapeControl("a\\b")).toBe("a\\\\b");
  });

  it("never serialises objects and drops secret-named fields", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", stderr: (l) => lines.push(l) });
    // Objects are refused by the type; force one through to check the runtime guard.
    log.info("call", { arguments: "city=Springfield", other: { city: "Springfield" } as unknown as string });
    expect(lines.join("")).not.toContain("Springfield");
    for (const name of ["authorization", "accessToken", "refresh_token", "codeVerifier", "rid", "toolArgs", "result", "signature", "privateKey"]) {
      expect(isSecretFieldName(name)).toBe(true);
    }
    for (const name of ["tool", "status", "intentId", "credential", "amount", "profile", "guard", "errorCode"]) {
      expect(isSecretFieldName(name)).toBe(false);
    }
  });

  it("refuses unsafe field keys and component names", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", stderr: (l) => lines.push(l) }).child("bad component\n");
    log.warn("m", { "k=v x": "1" });
    expect(lines[0]).toMatch(/ warn main m field=1\n$/);
  });
});

describe("secrets never reach stderr or the log file", () => {
  function sinks(): { lines: string[]; file: LogFile; log: Logger } {
    const lines: string[] = [];
    const file = openLogFile(join(dir, "assay.log"));
    const log = createLogger({ level: "debug", stderr: (l) => lines.push(l), file });
    return { lines, file, log };
  }

  it("through every logger call site", async () => {
    const { lines, file, log } = sinks();
    const stdout = vi.spyOn(process.stdout, "write");
    const all = Object.values(SECRETS).join(" ");
    for (const at of [log, log.child("oauth"), log.child("signer")]) {
      for (const level of ["error", "warn", "info", "debug"] as const) {
        at[level](`message ${all}`);
        at[level]("fields", {
          value: all,
          quoted: `"${all}"`,
          authorization: `Bearer ${SECRETS.accessToken}`,
          token: SECRETS.refreshToken,
          code: SECRETS.authCode,
          key: SECRETS.privateKey,
          sig: SECRETS.signature,
          error: new Error(`refresh failed for ${SECRETS.refreshToken} with ${SECRETS.privateKey}`),
          escaped: `\u001b${SECRETS.apiKey}\u0007`,
          [`k${SECRETS.bareKey}`]: 1,
        });
      }
    }

    // pinnedFetch logs through the same logger: the bearer, the URL and the body never appear.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const prod = builtInDeployments().production;
    await pinnedFetch(prod, `${prod.mcp}/?token=${SECRETS.accessToken}`, {
      method: "POST",
      bearer: SECRETS.accessToken,
      body: JSON.stringify({ signature: SECRETS.signature }),
      log,
    });
    fetchSpy.mockRejectedValueOnce(new Error(`connect failed ${SECRETS.apiKey}`));
    await expect(pinnedFetch(prod, prod.mcp, { bearer: SECRETS.apiKey, log })).rejects.toThrow();

    file.close();
    const stderrText = lines.join("");
    const fileText = readFileSync(join(dir, "assay.log"), "utf8");
    expect(stderrText).toContain("fetch");
    expect(stderrText.split("\n").length).toBeGreaterThan(24);
    assertClean(stderrText);
    assertClean(fileText);
    expect(fileText.split("\n")[0]).toBe(LOG_FILE_HEADER);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("the default stderr sink writes to stderr and never to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger({ level: "debug" });
    log.error("e", { token: SECRETS.accessToken });
    log.debug("d");
    resolveDeployment({
      url: "http://localhost:3200/",
      env: { ASSAY_MCP_DEV_ORIGINS: "http://localhost:3200" },
      devOrigins: ["http://localhost:3200"],
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(3);
    assertClean(stderr.mock.calls.map((c) => String(c[0])).join(""));
  });
});

describe("--log-file", () => {
  it.skipIf(!POSIX)("creates the file 0600 with the header and appends to it", () => {
    const path = join(dir, "new.log");
    const a = openLogFile(path);
    a.write("one");
    a.close();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const b = openLogFile(path);
    b.write("two\n");
    b.close();
    expect(readFileSync(path, "utf8")).toBe(`${LOG_FILE_HEADER}\none\ntwo\n`);
  });

  it("refuses a symlinked --log-file", () => {
    const target = join(dir, "real.log");
    openLogFile(target).close();
    const link = join(dir, "link.log");
    symlinkSync(target, link);
    expect(() => openLogFile(link)).toThrow(LogFileError);
    expect(() => openLogFile(link)).toThrow(/symbolic link/);
  });

  it("refuses a dangling symlink instead of creating its target", () => {
    const link = join(dir, "dangling.log");
    symlinkSync(join(dir, "elsewhere.log"), link);
    expect(() => openLogFile(link)).toThrow(LogFileError);
    expect(() => lstatSync(join(dir, "elsewhere.log"))).toThrow();
  });

  it("refuses a foreign file without the header and leaves it untouched", () => {
    const path = join(dir, "notes.log");
    writeFileSync(path, "my notes\n");
    expect(() => openLogFile(path)).toThrow(/not written by assay-mcp/);
    expect(readFileSync(path, "utf8")).toBe("my notes\n");
    writeFileSync(path, `${LOG_FILE_HEADER} but more\n`);
    expect(() => openLogFile(path)).toThrow(LogFileError);
  });

  it("refuses a directory", () => {
    mkdirSync(join(dir, "d.log"));
    expect(() => openLogFile(join(dir, "d.log"))).toThrow(/not a regular file/);
  });

  it("refuses a name that does not end in .log (no shell startup file can be planted)", () => {
    for (const name of [".zlogin", ".bashrc", "profile", "assay.log.sh", ".log", "x.LOG"]) {
      expect(() => openLogFile(join(dir, name)), name).toThrow(/must end in \.log/);
      expect(() => lstatSync(join(dir, name))).toThrow();
    }
  });

  it("refuses a missing or symlinked parent directory and never creates one", () => {
    expect(() => openLogFile(join(dir, "missing", "a.log"))).toThrow(/does not exist/);
    expect(() => lstatSync(join(dir, "missing"))).toThrow();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    expect(() => openLogFile(join(dir, "linked", "a.log"))).toThrow(/symbolic link/);
    expect(() => lstatSync(join(dir, "real", "a.log"))).toThrow();
  });

  it.skipIf(!POSIX || process.getuid?.() === 0)("refuses a parent directory owned by another user", () => {
    // `/` is owned by root on every POSIX runner; a non-root test user does not own it.
    expect(() => openLogFile("/assay-mcp-test.log")).toThrow(/another user/);
  });

  it.skipIf(!POSIX)("tightens an existing log file to 0600", () => {
    const path = join(dir, "loose.log");
    writeFileSync(path, `${LOG_FILE_HEADER}\n`, { mode: 0o644 });
    openLogFile(path).close();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });
});

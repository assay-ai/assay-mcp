import { RUN } from "../src/version.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientEnv, CliRunner } from "../src/clients/client.js";
import { parseCodexServers } from "../src/clients/codex.js";
import {
  CLIENT_IDS,
  addCommand,
  cliInvocation,
  installCommand,
  installLink,
  isAssayEntry,
  remoteCommand,
  serverEntry,
  shellQuote,
  type ClientId,
  type InstallInput,
} from "../src/clients/install-command.js";
import { installsStore, type InstallsLock } from "../src/clients/installs.js";
import { chooseName, nameRuleL, type NameInputs } from "../src/clients/install-name.js";
import { UrlRefused, slugWordsFor, type PrivateFiles, type ProfilePort, type ResolvedUrl } from "../src/clients/ports.js";
import { which } from "../src/clients/client.js";
import { CLIENTS } from "../src/clients/registry.js";
import { SIGN_IN_HINT } from "../src/clients/server-name.js";
import { runAdd } from "../src/commands/add-impl.js";
import type { InstallDeps } from "../src/commands/context.js";
import { runList } from "../src/commands/list-impl.js";
import { runRemove } from "../src/commands/remove-impl.js";
import { onPath, wiredDeps } from "../src/commands/wiring.js";
import { readPaidUrls } from "../src/profile/profile.js";
import { execFileSync } from "node:child_process";
import { VERSION } from "../src/version.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const vectors = JSON.parse(readFileSync(join(ROOT, "vectors/commands.json"), "utf8")) as {
  V: string;
  install: { client: ClientId; input: InstallInput; command: unknown; entry: unknown; link: string | null; remote: unknown }[];
  project: { cases: { input: InstallInput; args: string[] }[] };
  add: { cases: { client: ClientId; V: string; url: string; command: string }[] };
  ownership: { cases: { name: string; entry: unknown; ours: boolean }[] };
  quoting: { cases: { word: string; quoted: string }[] };
  names: { cases: (NameInputs & { expect?: string; refusal?: string })[] };
};
const V = vectors.V;
const MCP = "https://mcp.assay.ai";
const FILE_CLIENTS: ClientId[] = ["cursor", "vscode", "windsurf", "claude-desktop"];
const CLI_CLIENTS: ClientId[] = ["claude-code", "codex", "gemini"];

// ---- fixtures ---------------------------------------------------------------------------

let base: string;
let home: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "assay-mcp-clients-")));
  home = join(base, "home");
  project = join(base, "project");
  outside = join(base, "outside");
  for (const d of [home, project, outside]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, data: unknown, indent = 2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
}

/** Simulates the real CLIs' writes, so the adapters read back what a client would store. */
function fakeCliRunner(calls: { bin: string; argv: string[]; cwd: string }[]): CliRunner {
  return (bin, argv, { cwd }) => {
    calls.push({ bin, argv: [...argv], cwd });
    const a = [...argv];
    if (bin === "claude" || bin === "gemini") {
      const scopeAt = a.indexOf("--scope");
      const scope = a[scopeAt + 1]!;
      a.splice(scopeAt, 2);
      const path =
        bin === "claude"
          ? scope === "user" ? join(home, ".claude.json") : join(cwd, ".mcp.json")
          : scope === "user" ? join(home, ".gemini", "settings.json") : join(cwd, ".gemini", "settings.json");
      const doc = existsSync(path) ? readJson(path) : {};
      const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
      if (a[1] === "add") {
        const name = a[2]!;
        const rest = a.slice(3);
        if (rest[0] === "--") rest.shift();
        if (Object.hasOwn(servers, name)) return Promise.reject(new Error(`${name} already exists`));
        servers[name] = bin === "claude" ? { type: "stdio", command: rest[0], args: rest.slice(1), env: {} } : { command: rest[0], args: rest.slice(1) };
      } else {
        delete servers[a[2]!];
      }
      writeJson(path, { ...doc, mcpServers: servers });
      return Promise.resolve();
    }
    if (bin === "codex") {
      const path = join(home, ".codex", "config.toml");
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (a[1] === "add") {
        const name = a[2]!;
        const [command, ...args] = a.slice(4);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${text}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`);
      } else {
        const out: string[] = [];
        let skip = false;
        for (const line of text.split("\n")) {
          if (line.startsWith("[")) skip = line === `[mcp_servers.${a[2]}]`;
          if (!skip) out.push(line);
        }
        writeFileSync(path, out.join("\n"));
      }
      return Promise.resolve();
    }
    return Promise.reject(new Error(`unexpected ${bin}`));
  };
}

function resolveUrl(input: string): ResolvedUrl {
  const full = input.startsWith("/") ? `${MCP}${input}` : input;
  const u = new URL(full);
  const dev = u.origin === "http://localhost:3200";
  const environment = dev ? ("e2e" as const) : ("production" as const);
  if (u.origin !== MCP && !dev) throw new UrlRefused(`${u.origin} is not the Assay MCP origin`);
  const path = u.pathname;
  const pathAndQuery = `${path}${u.search}`;
  if (path === "/") {
    const tools = u.searchParams.get("tools");
    return {
      url: full,
      pathAndQuery,
      kind: "ROOT",
      slugWords: slugWordsFor({ kind: "ROOT" }, { tools: tools ? tools.split(",").map((name) => ({ name })) : null }),
      dev,
      environment,
    };
  }
  const c = /^\/c\/([a-z-]+)$/.exec(path);
  if (c) return { url: full, pathAndQuery, kind: "CATEGORY", slugWords: slugWordsFor({ kind: "CATEGORY", category: c[1]! }, { tools: null }), dev, environment };
  const my = /^\/my\/([a-z0-9-]+)$/.exec(path);
  if (my) return { url: full, pathAndQuery, kind: "MY_TOOLSET", slugWords: slugWordsFor({ kind: "MY_TOOLSET", slug: my[1]! }, { tools: null }), dev, environment };
  throw new UrlRefused("not an MCP URL");
}

interface Harness {
  deps: InstallDeps;
  /** The questions `prompt` was asked. */
  prompts: string[];
  out: string[];
  calls: { bin: string; argv: string[]; cwd: string }[];
  paid: { profile: string; url: string }[];
  store: Map<string, string>;
  profilesPresent: Set<string>;
  measured: { L: number | null };
}

function harness(overrides: Partial<InstallDeps> = {}): Harness {
  const out: string[] = [];
  const calls: Harness["calls"] = [];
  const paid: Harness["paid"] = [];
  const prompts: string[] = [];
  const store = new Map<string, string>();
  const profilesPresent = new Set<string>(["default"]);
  const measured = { L: 20 as number | null };
  const files: PrivateFiles = {
    read: (rel) => store.get(rel) ?? null,
    write: (rel, data) => void store.set(rel, data),
  };
  const lock: InstallsLock = (fn) => Promise.resolve().then(() => fn(() => undefined));
  const profiles: ProfilePort = {
    isValidName: (n) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(n),
    exists: (n) => profilesPresent.has(n),
    // Like paid-urls.json: every profile starts with `/`.
    isPaidUrl: (profile, url) => url.pathAndQuery === "/" || paid.some((p) => p.profile === profile && p.url === url.pathAndQuery),
    addPaidUrl: (profile, url) => (paid.push({ profile, url: url.pathAndQuery }), Promise.resolve()),
    longestTool: () => Promise.resolve(measured.L),
  };
  const clientEnv: ClientEnv = { home, platform: "linux", cwd: project, env: {}, run: fakeCliRunner(calls) };
  const deps: InstallDeps = {
    clients: CLIENTS,
    clientEnv,
    resolveUrl,
    profiles,
    installs: installsStore(files, lock),
    env: {},
    isTTY: true,
    onPath: () => false,
    ask: () => Promise.resolve(null),
    // The typed confirmation: the profile name.
    prompt: (q) => (prompts.push(q), Promise.resolve("default")),
    print: (t) => void out.push(t),
    version: V,
    productionOrigin: MCP,
    ...overrides,
  };
  return { deps, prompts, out, calls, paid, store, profilesPresent, measured };
}

function userConfig(client: ClientId): string {
  return CLIENTS[client].target("user", { home, platform: "linux", cwd: project, env: {}, run: () => Promise.resolve() }).configPath;
}

function entriesOf(client: ClientId, scope: "user" | "project" = "user"): Map<string, unknown> {
  const env: ClientEnv = { home, platform: "linux", cwd: project, env: {}, run: () => Promise.resolve() };
  const adapter = CLIENTS[client];
  return adapter.entries(adapter.target(scope, env), env);
}

/** The command and args an entry runs, whatever extra keys the client stores. */
function runPart(entry: unknown): { command: unknown; args: unknown } {
  const e = entry as { command: unknown; args: unknown };
  return { command: e.command, args: e.args };
}

/** Splits a vector shell line the way a POSIX shell would (single quotes only). */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  for (const m of line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) words.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!);
  return words;
}

// ---- vectors -----------------------------------------------------------------------------

describe("install commands equal vectors/commands.json", () => {
  it("covers every client for every URL case", () => {
    const clients = new Set(vectors.install.map((c) => c.client));
    expect([...clients].sort()).toEqual([...CLIENT_IDS].sort());
  });

  it.each(vectors.install.map((c) => [`${c.client} ${c.input.url}`, c] as const))("%s", (_label, c) => {
    expect(installCommand(c.client, c.input)).toEqual(c.command);
    expect(serverEntry(c.client, c.input)).toEqual(c.entry);
    expect(installLink(c.client, c.input)).toEqual(c.link);
    expect(remoteCommand(c.client, c.input)).toEqual(c.remote);
  });

  it("a dev origin's / keeps --url; only the production / omits it", () => {
    const base = { V: "1.2.3", name: "assay" };
    expect(serverEntry("cursor", { ...base, url: "https://mcp.assay.ai/" }).args).toEqual(["-y", "@goassay-ai/mcp@1.2.3", "--name", "assay"]);
    expect(serverEntry("cursor", { ...base, url: "http://localhost:3200/" }).args).toEqual(["-y", "@goassay-ai/mcp@1.2.3", "--url", "http://localhost:3200/", "--name", "assay"]);
    expect(serverEntry("vscode", { ...base, url: "http://localhost:3200/" }).args).toContain("--url");
  });

    it("pins the package exactly and never uses the unscoped form", () => {
    for (const c of vectors.install) {
      const text = JSON.stringify(c);
      expect(text).toContain(`@goassay-ai/mcp@${V}`);
      expect(text).not.toContain(["npx", "-y", "assay-mcp"].join(" "));
    }
  });

  it("project-scope args", () => {
    for (const c of vectors.project.cases) expect(serverEntry("cursor", c.input, "project").args).toEqual(c.args);
  });

  it("add one-liners", () => {
    for (const c of vectors.add.cases) expect(addCommand(c.client, { V: c.V, url: c.url })).toBe(c.command);
  });

  it.each(vectors.ownership.cases.map((c) => [c.name, c] as const))("ownership: %s", (_n, c) => {
    expect(isAssayEntry(c.entry)).toBe(c.ours);
  });

  it("CLI invocations run exactly the vector command", () => {
    for (const c of vectors.install.filter((v) => CLI_CLIENTS.includes(v.client))) {
      const { bin, argv } = cliInvocation(c.client, c.input);
      expect([bin, ...argv]).toEqual(shellSplit(c.command as string));
    }
  });

  it.each(vectors.quoting.cases.map((c) => [c.word, c] as const))("quoting: %s", (_w, c) => {
    expect(shellQuote(c.word)).toBe(c.quoted);
  });

  it.each(vectors.names.cases.map((c, i) => [i, c] as const))("names %#", (_i, c) => {
    const { expect: name, refusal, ...inputs } = c;
    const got = chooseName(inputs);
    if (name !== undefined) {
      expect(got).toEqual({ ok: true, name });
      if (inputs.scope === "project") expect(name.length).toBeLessThanOrEqual(16);
    } else {
      expect(got).toEqual({ ok: false, message: refusal });
    }
    expect(nameRuleL(20, "project")).toBe(41);
  });

  it("refuses ranges, bad names, credentials in the URL and project log files", () => {
    const ok: InstallInput = { V, url: `${MCP}/`, name: "assay" };
    expect(() => installCommand("codex", { ...ok, V: "^1.2.3" })).toThrow();
    expect(() => installCommand("codex", { ...ok, V: "latest" })).toThrow();
    expect(() => installCommand("codex", { ...ok, name: "Assay" })).toThrow();
    expect(() => installCommand("codex", { ...ok, url: "https://user:pw@mcp.assay.ai/" })).toThrow();
    expect(() => installCommand("codex", { ...ok, url: "https://mcp.assay.ai/'$(id)'" })).toThrow();
    expect(() => serverEntry("cursor", { ...ok, logFile: "/var/log/assay.log" }, "project")).toThrow();
    expect(() => serverEntry("cursor", { ...ok, logFile: "relative.log" })).toThrow();
  });
});

describe("README install commands equal vectors/commands.json (R-WEB-7, repo half)", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const withVersion = (s: string) => s.split(`@goassay-ai/mcp@${V}`).join(`@goassay-ai/mcp@${VERSION}`);
  const root = (client: ClientId) => vectors.install.find((c) => c.client === client && c.input.url === `${MCP}/`)!;

  it.each(["claude-code", "codex", "gemini", "vscode"] as ClientId[])("%s", (client) => {
    expect(readme).toContain(`\`${withVersion(root(client).command as string)}\``);
  });

  it("the JSON block is the Cursor, Windsurf and Claude Desktop config", () => {
    const block = /```json\n([\s\S]*?)```/.exec(readme);
    expect(block).not.toBeNull();
    const parsed = JSON.parse(block![1]!);
    for (const client of ["cursor", "windsurf", "claude-desktop"] as ClientId[]) {
      expect(parsed).toEqual(JSON.parse(withVersion(JSON.stringify(root(client).command))));
    }
  });

  it("the add one-liner", () => {
    expect(readme).toContain(withVersion(vectors.add.cases[0]!.command));
  });

  it("lists every client id", () => {
    for (const id of CLIENT_IDS) expect(readme).toContain(`\`${id}\``);
  });
});

// ---- add ------------------------------------------------------------------------------

describe("add", () => {
  it.each(CLIENT_IDS)("R-MU-9: %s entry equals the Connect UI vector for the same client", async (client) => {
    for (const url of [`${MCP}/`, `${MCP}/my/weather`]) {
      const h = harness();
      const vector = vectors.install.find((c) => c.client === client && c.input.url === url)!;
      expect(await runAdd([url, "--client", client, "--name", vector.input.name], h.deps)).toBe(0);
      const stored = entriesOf(client).get(vector.input.name);
      expect(isAssayEntry(stored)).toBe(true);
      if (client === "vscode") expect(stored).toEqual(vector.entry);
      else expect(runPart(stored)).toEqual(runPart(vector.entry));
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home);
    }
  });

  it.each(FILE_CLIENTS)("merge keeps other servers and keys: %s", async (client) => {
    const path = userConfig(client);
    const key = client === "vscode" ? "servers" : "mcpServers";
    const other = { command: "uvx", args: ["other-server"], env: { TOKEN: "x" } };
    const original = { theme: "dark", [key]: { other }, z: [1, 2] };
    writeJson(path, original, 4);
    const before = readFileSync(path, "utf8");
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", client], h.deps)).toBe(0);
    const after = readJson(path);
    expect(after.theme).toBe("dark");
    expect(after.z).toEqual([1, 2]);
    const servers = after[key] as Record<string, unknown>;
    expect(servers.other).toEqual(other);
    expect(Object.keys(servers)).toEqual(["other", "assay-weather"]);
    expect(readFileSync(path, "utf8")).toMatch(/^\{\n {4}"theme"/);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(before);
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it.each(CLI_CLIENTS)("merge keeps other servers: %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client, "--name", "other"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", client], h.deps)).toBe(0);
    expect([...entriesOf(client).keys()].sort()).toEqual(["assay-weather", "other"]);
  });

  it.each(CLIENT_IDS)("--force needed for an existing name: %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client, "--name", "assay"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", client, "--name", "assay"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("--force");
    expect(entriesOf(client).get("assay")).toSatisfy((e: unknown) => !JSON.stringify(e).includes("/c/weather"));
    expect(await runAdd(["/c/weather", "--client", client, "--name", "assay", "--force"], h.deps)).toBe(0);
    expect(JSON.stringify(entriesOf(client).get("assay"))).toContain(`${MCP}/c/weather`);
  });

  it.each(CLIENT_IDS)("the adapter itself refuses an existing name without force: %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client, "--name", "assay"], h.deps)).toBe(0);
    const adapter = CLIENTS[client];
    const target = adapter.target("user", h.deps.clientEnv);
    const input = { V, url: `${MCP}/c/weather`, name: "assay" };
    await expect(adapter.install(target, input, { force: false }, h.deps.clientEnv)).rejects.toThrow("--force");
    expect(JSON.stringify(entriesOf(client).get("assay"))).not.toContain("/c/weather");
  });

  it("a default name that is taken gets -2", async () => {
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(await runAdd(["/my/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect([...entriesOf("cursor").keys()]).toEqual(["assay-weather", "assay-weather-2"]);
  });

  it.each(CLIENT_IDS)("add again for the same URL and profile is already installed, exit 0 (M4): %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", client], h.deps)).toBe(0);
    const before = [...entriesOf(client).keys()];
    h.out.length = 0;
    expect(await runAdd(["/c/weather", "--client", client], h.deps)).toBe(0);
    expect(h.out.join("")).toBe(`assay-weather → ${MCP}/c/weather is already installed in ${CLIENTS[client].label}. Nothing changed. Pass a new --name to add a second entry.\n`);
    expect([...entriesOf(client).keys()]).toEqual(before);
    expect(h.deps.installs.read()).toHaveLength(1);
    // The same name typed again is no new name either.
    expect(await runAdd(["/c/weather", "--client", client, "--name", "assay-weather"], h.deps)).toBe(0);
    expect(h.deps.installs.read()).toHaveLength(1);
    // A new --name adds a second entry.
    expect(await runAdd(["/c/weather", "--client", client, "--name", "weather-two"], h.deps)).toBe(0);
    expect([...entriesOf(client).keys()].sort()).toEqual(["assay-weather", "weather-two"]);
  });

  it("--force on an existing install installs it again under its own name, never -2 (m5)", async () => {
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runAdd(["/c/weather", "--client", "cursor", "--force"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Added assay-weather →");
    expect([...entriesOf("cursor").keys()]).toEqual(["assay-weather"]);
    expect(h.deps.installs.read()).toHaveLength(1);
  });

  it("re-add of a user install whose URL is not paid prints the allow hint (m6)", async () => {
    const h = harness({ prompt: () => Promise.resolve(null) });
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("is already installed");
    expect(h.out.join("")).toContain(`Run \`${RUN} allow-paid ${MCP}/c/weather\` in a terminal`);
    h.paid.push({ profile: "default", url: "/c/weather" });
    h.out.length = 0;
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("allow-paid");
  });

  it("an install removed from the client config by hand is installed again", async () => {
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    writeJson(userConfig("cursor"), { mcpServers: {} });
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect([...entriesOf("cursor").keys()]).toEqual(["assay-weather"]);
  });

  it("another profile or scope is not the same install", async () => {
    const h = harness();
    h.profilesPresent.add("work");
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", "cursor", "--profile", "work"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect(h.deps.installs.read()).toHaveLength(3);
  });

  it("names: the default drops to assay for the root, and a typed name that does not fit is refused", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    expect([...entriesOf("cursor").keys()]).toEqual(["assay"]);
    h.measured.L = 40;
    expect(await runAdd(["/c/weather", "--client", "cursor", "--name", "a-very-long-server-name"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("is too long for this server: its longest tool is 40 characters, so the name can be at most 17.");
    h.measured.L = null;
    expect(await runAdd(["/c/weather", "--client", "cursor", "--name", "a-very-long-server-name"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("its longest tool is 48 characters");
    expect(h.out.join("")).toContain(SIGN_IN_HINT);
    expect(await runAdd(["/c/weather", "--client", "cursor", "--name", "Bad_Name"], h.deps)).toBe(2);
  });

  it("refuses another origin, and a dev origin in project scope", async () => {
    const h = harness();
    expect(await runAdd(["https://evil.example/c/weather", "--client", "cursor"], h.deps)).toBe(2);
    expect(await runAdd(["http://localhost:3200/c/weather", "--client", "cursor", "--scope", "project"], h.deps)).toBe(2);
    expect(existsSync(join(project, ".cursor"))).toBe(false);
    expect(existsSync(userConfig("cursor"))).toBe(false);
  });

  it("user scope on a TTY allows the URL for paid calls after the typed profile name, and records the install", async () => {
    const h = harness();
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(`Allow paid calls through ${MCP}/c/weather for profile "default"?`);
    expect(h.prompts[0]).toContain("Type the profile name (default) to confirm");
    expect(h.paid).toEqual([{ profile: "default", url: "/c/weather" }]);
    expect(h.deps.installs.read()).toEqual([
      { client: "cursor", scope: "user", name: "assay-weather", url: `${MCP}/c/weather`, profile: "default", configPath: userConfig("cursor") },
    ]);
    expect(h.out.join("")).toContain(`Added assay-weather → ${MCP}/c/weather. Restart Cursor if it is open.`);
  });

  it("a plain yes on the TTY does not allow paid calls; the install still happens (M5)", async () => {
    for (const answer of ["y", "yes", "", null, "Default"]) {
      const h = harness({ prompt: () => Promise.resolve(answer) });
      expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
      expect(h.paid).toEqual([]);
      expect(h.out.join("")).toContain(`This install did not allow paid calls for ${MCP}/c/weather. Run \`${RUN} allow-paid ${MCP}/c/weather\``);
      expect(entriesOf("cursor").has("assay-weather")).toBe(true);
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home);
    }
  });

  it("the root URL, which every profile starts with, asks nothing", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.paid).toEqual([]);
    expect(h.out.join("")).not.toContain("allow-paid");
  });

  it("a URL already allowed asks nothing", async () => {
    const h = harness();
    h.paid.push({ profile: "default", url: "/c/weather" });
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.paid).toEqual([{ profile: "default", url: "/c/weather" }]);
    expect(h.out.join("")).not.toContain("allow-paid");
  });

  it("without a TTY the URL is not allowed for paid calls", async () => {
    const h = harness({ isTTY: false });
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.paid).toEqual([]);
    expect(h.out.join("")).toContain("allow-paid");
  });

  it("writes no secret and no env into user-scope configs", async () => {
    const h = harness({ env: { ASSAY_API_KEY: "assay_sk_live_secretvalue" } });
    for (const client of CLIENT_IDS) expect(await runAdd(["/", "--client", client], h.deps)).toBe(0);
    for (const client of CLIENT_IDS) {
      const text = readFileSync(userConfig(client), "utf8");
      expect(text).not.toContain("assay_sk_live_");
      const entry = entriesOf(client).get("assay") as Record<string, unknown>;
      expect(entry.env === undefined || JSON.stringify(entry.env) === "{}").toBe(true);
    }
  });

  it("client: the only client CLI on PATH, else ask on a TTY, else fail with the list", async () => {
    let h = harness({ onPath: (bin) => bin === "codex" });
    expect(await runAdd(["/"], h.deps)).toBe(0);
    expect(h.calls[0]!.bin).toBe("codex");

    h = harness({ onPath: () => true, ask: () => Promise.resolve("cursor") });
    expect(await runAdd(["/"], h.deps)).toBe(0);
    expect(entriesOf("cursor").has("assay")).toBe(true);

    h = harness({ onPath: () => false, isTTY: false });
    expect(await runAdd(["/"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain(CLIENT_IDS.join(", "));
  });

  it("usage errors", async () => {
    const h = harness();
    expect(await runAdd([], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "notepad"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "cursor", "--scope", "global"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "cursor", "--name", "a", "--name", "b"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "cursor", "--bogus"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "windsurf", "--scope", "project"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "codex", "--scope", "project"], h.deps)).toBe(2);
  });
});

// ---- project scope ----------------------------------------------------------------------

describe("add --scope project", () => {
  const PROJECT_FILES: Partial<Record<ClientId, string>> = {
    cursor: ".cursor/mcp.json",
    vscode: ".vscode/mcp.json",
    "claude-code": ".mcp.json",
    gemini: ".gemini/settings.json",
  };

  it.each(Object.keys(PROJECT_FILES) as ClientId[])("project scope file contains no token, no dev origin, no log-file: %s", async (client) => {
    const h = harness({ env: { ASSAY_DEV_API_KEY: "assay_sk_live_devsecret", ASSAY_MCP_DEV_ORIGINS: "http://localhost:3200" } });
    h.profilesPresent.add("work");
    expect(await runAdd(["/c/weather", "--client", client, "--scope", "project", "--profile", "work"], h.deps)).toBe(0);
    const path = join(project, PROJECT_FILES[client]!);
    const text = readFileSync(path, "utf8");
    expect(text).not.toMatch(/assay_(sk_live|at|rt|ac)_|localhost|log-file|--name|HOME|APPDATA|XDG/);
    const entry = entriesOf(client, "project").get("assay-weather") as Record<string, unknown>;
    expect(entry.args).toEqual(["-y", `@goassay-ai/mcp@${V}`, "--url", `${MCP}/c/weather`, "--profile", "work"]);
    expect(entry.env === undefined || JSON.stringify(entry.env) === "{}").toBe(true);
    // R-MU-5 / R-MU-13: never allowed for paid calls from here.
    expect(h.paid).toEqual([]);
    expect(h.out.join("")).toContain(`A project install can pay only through URLs your profile already allows (\`/\` is allowed when you sign in); ${MCP}/c/weather stays free-only. Run`);
    expect(h.deps.installs.read()[0]).toMatchObject({ scope: "project", configPath: path });
  });

  it("a project install of / says it can pay through /, which the profile allows (M2 wording)", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`A project install can pay only through URLs your profile already allows (\`/\` is allowed when you sign in); ${MCP}/ is one of them.`);
    expect(h.out.join("")).not.toContain("never allows paid calls");
    expect(h.paid).toEqual([]);
  });

  it("project scope with ASSAY_API_KEY set → refused", async () => {
    const h = harness({ env: { ASSAY_API_KEY: "assay_sk_live_abc" } });
    expect(await runAdd(["/c/weather", "--client", "cursor", "--scope", "project"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("ASSAY_API_KEY");
    expect(existsSync(join(project, ".cursor"))).toBe(false);
    expect(h.store.size).toBe(0);
  });

  it("refuses --log-file and unknown profiles", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project", "--log-file", "/var/tmp/a.log"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project", "--profile", "nobody"], h.deps)).toBe(2);
    expect(existsSync(join(project, ".cursor"))).toBe(false);
  });

  it("never follows a project config outside the project root", async () => {
    symlinkSync(outside, join(project, ".cursor"));
    symlinkSync(join(outside, "x.json"), join(project, ".mcp.json"));
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project"], h.deps)).toBe(1);
    expect(await runAdd(["/", "--client", "claude-code", "--scope", "project"], h.deps)).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

// ---- safety of file edits ---------------------------------------------------------------

describe("config file edits", () => {
  it("refuses a symlinked config file", async () => {
    const real = join(outside, "mcp.json");
    writeJson(real, { mcpServers: {} });
    mkdirSync(join(home, ".cursor"));
    symlinkSync(real, join(home, ".cursor", "mcp.json"));
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("symbolic link");
    expect(readJson(real)).toEqual({ mcpServers: {} });
    expect(lstatSync(join(home, ".cursor", "mcp.json")).isSymbolicLink()).toBe(true);
  });

  it("refuses JSON with comments and leaves it untouched", async () => {
    const path = userConfig("vscode");
    mkdirSync(dirname(path), { recursive: true });
    const text = '{\n  // mine\n  "servers": {}\n}\n';
    writeFileSync(path, text);
    const h = harness();
    expect(await runAdd(["/", "--client", "vscode"], h.deps)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("creates a missing config with no .bak", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "claude-desktop"], h.deps)).toBe(0);
    const path = userConfig("claude-desktop");
    expect(readJson(path)).toEqual({ mcpServers: { assay: { command: "npx", args: ["-y", `@goassay-ai/mcp@${V}`, "--name", "assay"] } } });
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
});

// ---- list and remove --------------------------------------------------------------------

describe("list", () => {
  it("checks each install against the client config", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", "claude-code"], h.deps)).toBe(0);
    expect(await runAdd(["/my/notes", "--client", "vscode"], h.deps)).toBe(0);
    // removed by hand, changed by hand
    writeJson(userConfig("cursor"), { mcpServers: {} });
    const vs = readJson(userConfig("vscode"));
    (vs.servers as Record<string, unknown>)["assay-notes"] = { type: "stdio", command: "node", args: ["x.js"] };
    writeJson(userConfig("vscode"), vs);
    h.out.length = 0;
    expect(await runList([], h.deps)).toBe(0);
    const text = h.out.join("");
    expect(text).toMatch(/assay {2}cursor \(user\) {2}→ https:\/\/mcp\.assay\.ai\/ {2}missing/);
    expect(text).toMatch(/assay-weather {2}claude-code \(user\) {2}→ https:\/\/mcp\.assay\.ai\/c\/weather {2}ok/);
    expect(text).toMatch(/assay-notes {2}vscode \(user\) .* changed/);
  });

  it("says when there is nothing", async () => {
    const h = harness();
    expect(await runList([], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("No Assay servers");
    expect(await runList(["extra"], h.deps)).toBe(2);
  });
});

describe("remove", () => {
  it.each(CLIENT_IDS)("removes only its entry and the record, keeps others: %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client, "--name", "keep"], h.deps)).toBe(0);
    expect(await runAdd(["/c/weather", "--client", client], h.deps)).toBe(0);
    expect(await runRemove(["assay-weather"], h.deps)).toBe(0);
    expect([...entriesOf(client).keys()]).toEqual(["keep"]);
    expect(h.deps.installs.read().map((r) => r.name)).toEqual(["keep"]);
    expect(h.out.join("")).toContain("This does not sign out");
  });

  it("refuses an entry assay-mcp did not write, even under a recorded name", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    const path = userConfig("cursor");
    writeJson(path, { mcpServers: { assay: { command: "npx", args: ["-y", "someone-else"] } } });
    expect(await runRemove(["assay"], h.deps)).toBe(2);
    expect(readJson(path)).toEqual({ mcpServers: { assay: { command: "npx", args: ["-y", "someone-else"] } } });
    // an unrecorded name with --client: same rule
    writeJson(path, { mcpServers: { mine: { command: "uvx", args: ["mine"] } } });
    expect(await runRemove(["mine", "--client", "cursor"], h.deps)).toBe(2);
    expect(Object.keys((readJson(path).mcpServers as object))).toEqual(["mine"]);
  });

  it("removes an unrecorded entry of ours with --client, and forgets one already removed by hand", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    h.store.clear();
    expect(await runRemove(["assay", "--client", "cursor"], h.deps)).toBe(0);
    expect(entriesOf("cursor").size).toBe(0);

    expect(await runAdd(["/", "--client", "windsurf"], h.deps)).toBe(0);
    writeJson(userConfig("windsurf"), { mcpServers: {} });
    expect(await runRemove(["assay"], h.deps)).toBe(0);
    expect(h.deps.installs.read()).toEqual([]);
    expect(await runRemove(["assay"], h.deps)).toBe(2);
  });

  it("needs --client when the name is in several clients", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    expect(await runAdd(["/", "--client", "windsurf"], h.deps)).toBe(0);
    expect(await runRemove(["assay"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("pass --client <id>");
    expect(h.out.join("")).not.toContain("--scope");
    expect(await runRemove(["assay", "--client", "windsurf"], h.deps)).toBe(0);
    expect(entriesOf("cursor").has("assay")).toBe(true);
  });

  it("removes a project install from its project, whatever the current directory", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "claude-code", "--scope", "project"], h.deps)).toBe(0);
    h.deps.clientEnv.cwd = outside;
    expect(await runRemove(["assay"], h.deps)).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({ bin: "claude", argv: ["mcp", "remove", "--scope", "project", "assay"], cwd: project });
    expect(readJson(join(project, ".mcp.json")).mcpServers).toEqual({});
  });
});

// ---- helpers ----------------------------------------------------------------------------

describe("helpers", () => {
  it("the Codex reader: a real TOML parser, exact ownership, fail closed", () => {
    const ours = `command = "npx"\nargs = ["-y", "@goassay-ai/mcp@${V}", "--name", "assay"]`;
    const codexOurs = (toml: string, name: string) => CLIENTS.codex.isOurs(parseCodexServers(toml).get(name));
    expect(codexOurs(`model = "x"\n[mcp_servers.assay]\n${ours}\n`, "assay")).toBe(true);
    // multi-line array, literal strings
    expect(codexOurs(`[mcp_servers.assay]\ncommand = 'npx'\nargs = [\n  "-y",\n  '@goassay-ai/mcp@${V}',\n  "--name", "assay",\n]\n`, "assay")).toBe(true);
    // any extra key keeps the entry: env subtable, dotted env key, quoted key, inline env, another key
    for (const extra of [
      `${ours}\n[mcp_servers.assay.env]\nHOME = "/tmp"`,
      `${ours}\nenv.ASSAY_API_KEY = "x"`,
      `${ours}\n"env" = { X = "1" }`,
      `${ours}\nenv = {}`,
      `${ours}\ncwd = "/tmp"`,
      `${ours}\nstartup_timeout_sec = 5`,
    ]) {
      expect(codexOurs(`[mcp_servers.assay]\n${extra}\n`, "assay")).toBe(false);
    }
    // names in any valid TOML form are seen
    expect([...parseCodexServers(`[mcp_servers]\nassay = { command = "npx", args = [] }\n`).keys()]).toEqual(["assay"]);
    expect([...parseCodexServers(`mcp_servers.assay.command = "npx"\n`).keys()]).toEqual(["assay"]);
    expect([...parseCodexServers(`[mcp_servers."assay"]\ncommand = "npx"\n`).keys()]).toEqual(["assay"]);
    expect([...parseCodexServers(`mcp_servers = { assay = { command = "uvx" } }\n`).keys()]).toEqual(["assay"]);
    // invalid TOML or a non-table mcp_servers is refused
    expect(() => parseCodexServers(`[mcp_servers.assay\ncommand = "npx"`)).toThrow("not valid TOML");
    expect(() => parseCodexServers(`mcp_servers = "x"\n`)).toThrow("not a table");
  });

  it("add sees a Codex name written in another TOML form, and refuses an unreadable config", async () => {
    const path = join(home, ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `[mcp_servers]\nassay = { command = "uvx", args = ["mine"] }\n`);
    const h = harness();
    expect(await runAdd(["/", "--client", "codex", "--name", "assay"], h.deps)).toBe(2);
    expect(await runAdd(["/", "--client", "codex"], h.deps)).toBe(0);
    expect(h.calls.at(-1)!.argv.slice(0, 3)).toEqual(["mcp", "add", "assay-2"]);
    writeFileSync(path, `[mcp_servers.assay\n`);
    expect(await runAdd(["/c/weather", "--client", "codex"], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("not valid TOML");
  });

  it.each(CLIENT_IDS)("remove keeps an entry with an extra env key and warns; list says changed: %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client], h.deps)).toBe(0);
    const path = userConfig(client);
    if (client === "codex") {
      writeFileSync(path, `${readFileSync(path, "utf8")}env = { ASSAY_API_KEY = "x" }\n`);
    } else {
      const doc = readJson(path);
      const servers = doc[client === "vscode" ? "servers" : "mcpServers"] as Record<string, Record<string, unknown>>;
      servers.assay!.env = { ASSAY_API_KEY: "x" };
      writeJson(path, doc);
    }
    const before = readFileSync(path, "utf8");
    h.out.length = 0;
    expect(await runList([], h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(/assay {2}.* changed/);
    expect(await runRemove(["assay"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("warning");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(h.calls.filter((c) => c.argv[1] === "remove")).toEqual([]);
    expect(h.deps.installs.read()).toHaveLength(1);
  });

  it("remove with a name in both scopes of one client names both, and --scope picks one (M11)", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runRemove(["assay", "--client", "cursor"], h.deps)).toBe(2);
    const msg = h.out.join("");
    expect(msg).toContain("cursor user");
    expect(msg).toContain(`cursor project (${join(project, ".cursor", "mcp.json")})`);
    expect(msg).toContain("pass --scope user|project");
    expect(msg).not.toContain("--client");
    expect(await runRemove(["assay", "--scope", "bogus"], h.deps)).toBe(2);
    expect(await runRemove(["assay", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect(entriesOf("cursor", "project").has("assay")).toBe(false);
    expect(entriesOf("cursor").has("assay")).toBe(true);
    expect(h.deps.installs.read().map((r) => r.scope)).toEqual(["user"]);
    expect(await runRemove(["assay", "--scope", "user"], h.deps)).toBe(0);
    expect(h.deps.installs.read()).toEqual([]);
  });

  it("remove --scope project finds an unrecorded entry of ours in the current project", async () => {
    const h = harness();
    expect(await runAdd(["/", "--client", "vscode", "--scope", "project"], h.deps)).toBe(0);
    h.store.clear();
    expect(await runRemove(["assay", "--client", "vscode"], h.deps)).toBe(2);
    expect(await runRemove(["assay", "--client", "vscode", "--scope", "project"], h.deps)).toBe(0);
    expect(entriesOf("vscode", "project").size).toBe(0);
    expect(await runRemove(["assay", "--client", "windsurf", "--scope", "project"], h.deps)).toBe(2);
  });

  it("slug words for default names", () => {
    expect(slugWordsFor({ kind: "ROOT" }, { tools: null })).toEqual([]);
    expect(slugWordsFor({ kind: "ROOT" }, { tools: [{ name: "get_weather" }] })).toEqual(["get"]);
    expect(slugWordsFor({ kind: "PUBLIC_TOOLSET", slug: "twitter-kit" }, { tools: null })).toEqual(["twitter", "kit"]);
    expect(slugWordsFor({ kind: "HANDLE", handle: "acme" }, { tools: null })).toEqual(["acme"]);
    expect(slugWordsFor({ kind: "UNLISTED_TOOLSET" }, { tools: null })).toEqual([]);
  });

  // POSIX exec bits and /bin/sh: not meaningful on Windows.
  it.skipIf(process.platform === "win32")("onPath finds executables without running anything", () => {
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(bin, "codex"), "not executable", { mode: 0o644 });
    expect(onPath("claude", bin, "linux")).toBe(true);
    expect(onPath("codex", bin, "linux")).toBe(false);
    expect(onPath("gemini", bin, "linux")).toBe(false);
  });
});

// ---- fix round 1: injection, .bak symlinks, races, PATH, CRLF, wiring ---------------------

/** Every word a shell gives `printf` for `line`, so the line is parsed exactly as a user's paste would be. */
function shellWords(shell: string, line: string): string[] {
  const out = execFileSync(shell, ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  return out.split("\0").slice(0, -1);
}

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((s) => existsSync(s));
const HOSTILE = ["$(id)", "`id`", ";id", "&&id", "|id", "!x", "*", "?", "'", '"', "\n", " ", "\\", ">x", "<x", "~x", "=x", "(x)", "$HOME", "#x", "%0a", "é", "‮"];

/** The printed shell lines for one input: every CLI install, every remote, the add one-liner, VS Code. */
function printedLines(input: InstallInput): { line: string; url: string; json?: boolean; noName?: boolean }[] {
  const lines: { line: string; url: string; json?: boolean; noName?: boolean }[] = [];
  for (const client of CLI_CLIENTS) {
    lines.push({ line: installCommand(client, input) as string, url: input.url });
    lines.push({ line: remoteCommand(client, input) as string, url: input.url });
    lines.push({ line: addCommand(client, input), url: input.url, noName: true });
  }
  lines.push({ line: installCommand("vscode", input) as string, url: input.url, json: true });
  return lines;
}

function checkRoundTrip(shell: string, input: InstallInput): void {
  for (const { line, url, json, noName } of printedLines(input)) {
    const words = shellWords(shell, line);
    if (json) {
      expect(words.length).toBe(3);
      expect((JSON.parse(words[2]!) as { args: string[] }).args).toContain(url);
    } else {
      expect(words.filter((w) => w === url)).toHaveLength(1);
      expect(words).toEqual(shellSplit(line));
    }
    if (!noName) expect(json ? JSON.parse(words[2]!).name : words).toContain(input.name);
  }
}

// Hundreds of shell spawns: generous timeout so a loaded machine does not flake.
describe("printed commands survive the shell (I3)", { timeout: 60_000 }, () => {
  it.each(SHELLS)("each metacharacter is either refused or comes back as one identical word: %s", (shell) => {
    let accepted = 0;
    for (const bad of HOSTILE) {
      const input: InstallInput = { V, url: `${MCP}/c/a${bad}b`, name: "assay-x" };
      let ok = true;
      try {
        installCommand("claude-code", input);
      } catch {
        ok = false;
      }
      if (!ok) {
        for (const client of CLIENT_IDS) expect(() => installCommand(client, input)).toThrow();
        expect(() => addCommand("cursor", input)).toThrow();
        continue;
      }
      accepted += 1;
      checkRoundTrip(shell, input);
    }
    expect(accepted).toBeGreaterThan(5);
  });

  // POSIX exec bits and /bin/sh: not meaningful on Windows.
  it.skipIf(process.platform === "win32")("property: random hostile URLs and names never break out of their word", () => {
    // mulberry32: a fixed seed, so a failure reproduces
    let seed = 0x2b11;
    const rand = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0;
    };
    const safe = ["a", "z", "0", "-", "_", ".", "/", ":", "@", ",", "=", "+", "%"];
    const shellMeta = ["&", "$", "(", ")", ";", "!", "*", "?", "=", "~"];
    const alphabet = [...safe, ...safe, ...safe, ...shellMeta, ...shellMeta, ...shellMeta, ...HOSTILE];
    let accepted = 0;
    for (let i = 0; i < 200; i += 1) {
      const tail = Array.from({ length: 1 + rand(6) }, () => alphabet[rand(alphabet.length)]).join("");
      const name = rand(4) === 0 ? `a${tail}` : "assay-p";
      const input: InstallInput = { V, url: `${MCP}/c/${tail}`, name };
      let lines;
      try {
        lines = printedLines(input);
      } catch (err) {
        expect((err as Error).name).toBe("InstallInputError");
        continue;
      }
      accepted += 1;
      expect(lines.length).toBeGreaterThan(0);
      checkRoundTrip(SHELLS[0]!, input);
    }
    expect(accepted).toBeGreaterThan(20);
  });
});

describe(".bak symlinks are replaced, never followed (I4)", () => {
  it("project scope", async () => {
    const victim = join(outside, "victim");
    writeFileSync(victim, "keep me");
    mkdirSync(join(project, ".cursor"));
    writeJson(join(project, ".cursor", "mcp.json"), { mcpServers: {} });
    symlinkSync(victim, join(project, ".cursor", "mcp.json.bak"));
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    const bak = join(project, ".cursor", "mcp.json.bak");
    expect(lstatSync(bak).isFile()).toBe(true);
    expect(readJson(bak)).toEqual({ mcpServers: {} });
    expect(h.out.join("")).toContain(".bak; do not commit it");
  });

  it("user scope", async () => {
    const victim = join(outside, "victim");
    writeFileSync(victim, "keep me");
    const path = userConfig("claude-desktop");
    writeJson(path, { mcpServers: {} });
    symlinkSync(victim, `${path}.bak`);
    const h = harness();
    expect(await runAdd(["/", "--client", "claude-desktop"], h.deps)).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(`${path}.bak`).isFile()).toBe(true);
  });
});

describe("other fixes", () => {
  it("project-scope names fit the 16-character budget (I1)", async () => {
    const h = harness();
    writeFileSync(join(project, "x"), "");
    expect(await runAdd(["/my/twitter-kit", "--client", "cursor", "--scope", "project"], h.deps)).toBe(0);
    expect([...entriesOf("cursor", "project").keys()]).toEqual(["assay-twitter"]);
    expect(await runAdd(["/", "--client", "cursor", "--scope", "project", "--name", "a-seventeen-chars"], h.deps)).toBe(2);
    expect(h.out.join("")).toContain("budgets 16 characters");
    expect(await runAdd(["/my/twitter-kit", "--client", "cursor"], h.deps)).toBe(0);
    expect([...entriesOf("cursor").keys()]).toEqual(["assay-twitter-kit"]);
  });

  it.each(CLIENT_IDS)("uninstall re-checks ownership on its own read (M4): %s", async (client) => {
    const h = harness();
    expect(await runAdd(["/", "--client", client], h.deps)).toBe(0);
    const adapter = CLIENTS[client];
    const target = adapter.target("user", h.deps.clientEnv);
    // the entry changes between remove's check and the uninstall
    const path = userConfig(client);
    if (client === "codex") writeFileSync(path, `[mcp_servers.assay]\ncommand = "uvx"\nargs = ["mine"]\n`);
    else {
      const key = client === "vscode" ? "servers" : "mcpServers";
      writeJson(path, { [key]: { assay: { command: "uvx", args: ["mine"] } } });
    }
    await expect(adapter.uninstall(target, "assay", h.deps.clientEnv)).rejects.toThrow("left unchanged");
    expect(entriesOf(client).has("assay")).toBe(true);
  });

  it("records the install even when allowing paid calls fails (M5)", async () => {
    const h = harness();
    h.deps.profiles.addPaidUrl = () => Promise.reject(new Error("lock busy"));
    expect(await runAdd(["/c/weather", "--client", "cursor"], h.deps)).toBe(0);
    expect(h.deps.installs.read()).toHaveLength(1);
    expect(h.out.join("")).toContain("allow-paid");
  });

  // POSIX exec bits and /bin/sh: not meaningful on Windows.
  it.skipIf(process.platform === "win32")("which skips empty and relative PATH entries (M7)", () => {
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(project, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const rel = relative(process.cwd(), project);
    expect(which("claude", `:.:${rel}:${bin}`, "linux")).toBe(join(bin, "claude"));
    expect(which("claude", `:.:${rel}`, "linux")).toBeNull();
  });

  it("keeps CRLF line endings (M8)", async () => {
    const path = userConfig("cursor");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{\r\n  "mcpServers": {}\r\n}\r\n');
    const h = harness();
    expect(await runAdd(["/", "--client", "cursor"], h.deps)).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("wired to the URL parser, {dir} files and the profile store", () => {
  function wired(isTTY = true) {
    const out: string[] = [];
    const calls: { bin: string; argv: string[]; cwd: string }[] = [];
    const dir = join(base, "cfg");
    const deps = wiredDeps({
      dir,
      home,
      cwd: project,
      platform: "linux",
      env: {},
      run: fakeCliRunner(calls),
      isTTY,
      print: (t) => void out.push(t),
      ask: () => Promise.resolve(null),
      prompt: () => Promise.resolve("default"),
      onPath: () => false,
    });
    return { deps, out, dir };
  }

  it("add → paid-urls and installs.json under {dir}, list, remove", async () => {
    const { deps, out, dir } = wired();
    expect(await runAdd(["/c/weather", "--client", "cursor"], deps)).toBe(0);
    expect(await runAdd([`${MCP}/?tools=get_weather`, "--client", "cursor"], deps)).toBe(0);
    // signed out (no tools/list yet): L = 48, so `/c/weather` gets `assay` and `assay-get` (9) just fits
    expect([...entriesOf("cursor").keys()]).toEqual(["assay", "assay-get"]);
    expect(readPaidUrls({ dir, name: "default" })).toEqual(["/", "/c/weather", "/?tools=get_weather"]);
    const installs = join(dir, "installs.json");
    if (process.platform !== "win32") expect(lstatSync(installs).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(installs, "utf8")) as unknown[]).length).toBe(2);
    out.length = 0;
    expect(await runList([], deps)).toBe(0);
    expect(out.join("")).toMatch(/assay {2}cursor \(user\) {2}→ https:\/\/mcp\.assay\.ai\/c\/weather {2}ok/);
    expect(await runRemove(["assay"], deps)).toBe(0);
    expect([...entriesOf("cursor").keys()]).toEqual(["assay-get"]);
    expect(deps.installs.read().map((r) => r.name)).toEqual(["assay-get"]);
  });

  it("canonicalises like the server and refuses other origins and unknown paths", async () => {
    const { deps } = wired();
    expect(deps.resolveUrl("/c/weather?discovery=auto").url).toBe(`${MCP}/c/weather`);
    expect(() => deps.resolveUrl("https://evil.example/c/weather")).toThrow(UrlRefused);
    expect(() => deps.resolveUrl("http://localhost:3200/")).toThrow(UrlRefused);
    expect(() => deps.resolveUrl("/oauth/authorize")).toThrow(UrlRefused);
    expect(() => deps.resolveUrl("/c/$(id)")).toThrow(UrlRefused);
    expect(await runAdd(["/nope/x", "--client", "cursor"], deps)).toBe(2);
    expect(existsSync(userConfig("cursor"))).toBe(false);
  });

  it("project scope: only an existing profile; no paid-urls write", async () => {
    const { deps, dir } = wired();
    expect(await runAdd(["/c/weather", "--client", "cursor", "--scope", "project", "--profile", "work"], deps)).toBe(2);
    expect(await runAdd(["/c/weather", "--client", "cursor", "--scope", "project"], deps)).toBe(0);
    expect(existsSync(join(dir, "profiles", "default.paid-urls.json"))).toBe(false);
  });
});

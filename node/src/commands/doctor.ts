/**
 * `assay-mcp doctor [--profile <name>]`: checks for the hostile-project-config risks of
 * spec §11 T13 and reports them, on stderr. Read only: it changes no file.
 *
 * - Project-scope Assay entries (the current directory's project configs of every client,
 *   and every project install in `installs.json`): any `env` key other than `ASSAY_*` is
 *   flagged, because a project config can use it to change how assay-mcp runs
 *   (`NODE_OPTIONS`, `HTTPS_PROXY`, ...). So are an API key or dev origins in a project file,
 *   an `envFile`, and an entry that does not run the pinned package as `add` writes it.
 * - This terminal's environment: the variables `serve` refuses or warns about.
 * - Local state: dev origins allowed, the env-proxy opt-in, the keychain.
 * - The accepted residual risk: `NODE_OPTIONS=--require` in an entry runs before any
 *   assay-mcp code; only the MCP client's approval of project servers stops it.
 * Exit 0 when nothing was flagged, 1 otherwise.
 */
import { RUN } from "../version.js";
import type { ClientEnv, Target } from "../clients/client.js";
import { isAssayEntry, PACKAGE_NAME } from "../clients/install-command.js";
import { EXIT_FATAL, EXIT_OK } from "../exit-codes.js";
import { readDevOrigins } from "../profile/dev-origins.js";
import { readSettings } from "../profile/settings.js";
import { parseFlags } from "./context.js";
import { printable } from "./format.js";
import { checkProfileName, defaultProfileDeps, installRecords, profileRef, reportFailure, type ProfileDeps } from "./profile-context.js";

export interface Finding {
  level: "problem" | "note";
  text: string;
}

/** Env vars `serve` refuses (unless opted in) or warns about (ruling 2.4-N1). */
const PROXY_VARS = ["NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const PRELOAD_OPTIONS = /(^|\s)(--require|-r|--import|--loader|--experimental-loader)(=|\s|$)/;

export const T13_RISK_TEXT =
  "A project config (.mcp.json and the like) can set the environment of the servers it starts. assay-mcp refuses certificate-check bypasses and env proxies at start, but NODE_OPTIONS=--require runs code before assay-mcp starts: only your MCP client's approval of project servers stops it. URLs from project configs are free-only until you run allow-paid in a terminal.";

function looksLikeAssay(name: string, entry: unknown): boolean {
  if (/^assay/i.test(name)) return true;
  try {
    const text = JSON.stringify(entry) ?? "";
    return text.includes(PACKAGE_NAME) || text.includes("assay-mcp");
  } catch {
    return false;
  }
}

/** Findings for one project-scope entry. */
export function checkProjectEntry(where: string, name: string, entry: unknown): Finding[] {
  const out: Finding[] = [];
  const at = `${where}: server "${name}"`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [{ level: "problem", text: `${at} is not an object` }];
  const e = entry as Record<string, unknown>;
  const env = e.env;
  if (env !== undefined && env !== null && typeof env === "object" && !Array.isArray(env)) {
    for (const key of Object.keys(env)) {
      if (!key.startsWith("ASSAY_")) {
        out.push({ level: "problem", text: `${at} sets ${key} in its environment. A project config can use it to change how assay-mcp runs; remove it unless you put it there yourself.` });
      } else if (key === "ASSAY_API_KEY" || key === "ASSAY_DEV_API_KEY") {
        out.push({ level: "problem", text: `${at} carries ${key} in a project file. Keys belong in your own environment, never in a shared config.` });
      } else if (key === "ASSAY_MCP_DEV_ORIGINS") {
        out.push({ level: "problem", text: `${at} asks for dev mode (${key}). A project config should never do this.` });
      }
    }
  } else if (env !== undefined) {
    out.push({ level: "problem", text: `${at} has an env value that is not an object` });
  }
  if (e.envFile !== undefined) out.push({ level: "problem", text: `${at} loads its environment from a file (envFile).` });
  if (!isAssayEntry({ command: e.command, args: e.args, ...(e.type !== undefined ? { type: e.type } : {}) })) {
    out.push({ level: "problem", text: `${at} does not run the pinned ${PACKAGE_NAME} package the way \`${RUN} add\` writes it.` });
  } else if ((e.args as string[]).includes("--log-file")) {
    out.push({ level: "problem", text: `${at} passes --log-file, which a project config must not.` });
  }
  return out;
}

function projectTargets(deps: ProfileDeps, clientEnv: ClientEnv, findings: Finding[]): { label: string; target: Target; read: () => Map<string, unknown> }[] {
  const seen = new Set<string>();
  const out: { label: string; target: Target; read: () => Map<string, unknown> }[] = [];
  const push = (label: string, target: Target, read: () => Map<string, unknown>) => {
    if (seen.has(target.configPath)) return;
    seen.add(target.configPath);
    out.push({ label, target, read });
  };
  for (const client of Object.values(deps.clients)) {
    if (!client.scopes.includes("project")) continue;
    try {
      const target = client.target("project", clientEnv);
      push(client.label, target, () => client.entries(target, clientEnv));
    } catch (err) {
      findings.push({ level: "problem", text: `${client.label} project config in this directory could not be checked: ${(err as Error).message}` });
    }
  }
  let records: ReturnType<typeof installRecords> = [];
  try {
    records = installRecords(deps);
  } catch (err) {
    findings.push({ level: "problem", text: `installs.json could not be read: ${(err as Error).message}` });
  }
  for (const r of records) {
    if (r.scope !== "project") continue;
    const client = deps.clients[r.client];
    try {
      const target = client.targetOf("project", r.configPath, clientEnv);
      push(client.label, target, () => client.entries(target, clientEnv));
    } catch (err) {
      findings.push({ level: "problem", text: `${r.configPath} (${client.label}) could not be checked: ${(err as Error).message}` });
    }
  }
  return out;
}

export async function doctorFindings(args: readonly string[], deps: ProfileDeps): Promise<{ findings: Finding[]; checked: string[] }> {
  const { values } = parseFlags(args, { profile: { type: "string" } }, 0);
  const profile = checkProfileName(values.profile as string | undefined);
  const findings: Finding[] = [];
  const checked: string[] = [];
  const clientEnv: ClientEnv = {
    home: deps.home,
    platform: deps.platform,
    cwd: deps.cwd,
    env: deps.env,
    run: () => Promise.reject(new Error("doctor runs no client")),
  };

  for (const { label, target, read } of projectTargets(deps, clientEnv, findings)) {
    let entries: Map<string, unknown>;
    try {
      entries = read();
    } catch (err) {
      findings.push({ level: "problem", text: `${target.configPath} (${label}) could not be read: ${(err as Error).message}` });
      continue;
    }
    for (const [name, entry] of entries) {
      if (!looksLikeAssay(name, entry)) continue;
      const found = checkProjectEntry(target.configPath, name, entry);
      if (found.length === 0) checked.push(`${target.configPath} (${label}): server "${name}" has nothing unexpected`);
      findings.push(...found);
    }
  }

  const env = deps.env;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") {
    findings.push({ level: "problem", text: "NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this terminal: certificate checks are off. assay-mcp refuses to serve with it." });
  }
  const proxies = PROXY_VARS.filter((k) => (env[k] ?? "").trim() !== "");
  if (proxies.length > 0) findings.push({ level: "note", text: `${proxies.join(", ")} set in this terminal: ${RUN} serves through it only if \`${RUN} settings set --allow-env-proxy on\` was run for the profile.` });
  if ((env.NODE_EXTRA_CA_CERTS ?? "").trim() !== "") findings.push({ level: "problem", text: "NODE_EXTRA_CA_CERTS is set in this terminal: extra certificate authorities are trusted for Assay traffic." });
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (PRELOAD_OPTIONS.test(nodeOptions)) findings.push({ level: "problem", text: "NODE_OPTIONS in this terminal preloads code into every Node program, assay-mcp included." });
  if ((env.ASSAY_MCP_DEV_ORIGINS ?? "").trim() !== "") findings.push({ level: "note", text: "ASSAY_MCP_DEV_ORIGINS is set in this terminal (dev mode, together with dev-origins.json)." });

  const devOrigins = readDevOrigins(deps.dir);
  if (devOrigins.length > 0) findings.push({ level: "note", text: `Dev mode is allowed for ${devOrigins.join(", ")} (dev-origins.json).` });
  try {
    if (readSettings(profileRef(deps, profile)).allowEnvProxy) {
      findings.push({ level: "note", text: `Profile "${profile}" allows an HTTP proxy from the environment (settings).` });
    }
  } catch (err) {
    findings.push({ level: "problem", text: `Profile "${profile}" settings could not be read: ${(err as Error).message}` });
  }
  try {
    await (await deps.openKeychain()).probe();
    checked.push("OS keychain: available");
  } catch (err) {
    findings.push({ level: "problem", text: (err as Error).message });
  }
  return { findings, checked };
}

export async function runDoctor(args: readonly string[], deps: ProfileDeps): Promise<number> {
  try {
    const { findings, checked } = await doctorFindings(args, deps);
    for (const c of checked) deps.print(`ok    ${printable(c)}\n`);
    for (const f of findings) deps.print(`${f.level === "problem" ? "!!   " : "note "} ${printable(f.text)}\n`);
    deps.print(`\nKnown risk (T13): ${T13_RISK_TEXT}\n`);
    const problems = findings.filter((f) => f.level === "problem").length;
    deps.print(problems === 0 ? "No problems found.\n" : `${problems} problem${problems === 1 ? "" : "s"} found.\n`);
    return problems === 0 ? EXIT_OK : EXIT_FATAL;
  } catch (err) {
    return reportFailure("doctor", err, deps);
  }
}

/** `assay-mcp doctor`. */
export function run(args: readonly string[]): Promise<number> {
  return runDoctor(args, defaultProfileDeps());
}

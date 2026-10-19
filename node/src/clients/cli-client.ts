/**
 * A client configured through its own CLI (`claude`, `codex`, `gemini`). `add` and `remove` run
 * the client's command through `execFile`; the config file is only read, to list names, to check
 * that an entry is ours before removing it, and to confirm what the CLI wrote.
 */
import type { ClientAdapter, ClientEnv, Target } from "./client.js";
import { ClientError } from "./client.js";
import { projectConfigPath, projectRootOf } from "./config-file.js";
import { cliInvocation, isAssayEntry, serverEntry, type ClientId, type Scope } from "./install-command.js";

export interface CliClientSpec {
  id: ClientId;
  label: string;
  bin: "claude" | "codex" | "gemini";
  userPath(env: ClientEnv): string;
  projectRel?: string;
  /** Server entries by name from the config file (empty when it does not exist). */
  read(configPath: string): Map<string, unknown>;
  removeArgv(name: string, scope: Scope): string[];
  /** Exactly what the client stores for what `add` wrote; default {@link isAssayEntry}. */
  isOurs?(entry: unknown): boolean;
}

function sameArgs(isOurs: (e: unknown) => boolean, entry: unknown, expected: readonly string[]): boolean {
  if (!isOurs(entry)) return false;
  const args = (entry as { args: string[] }).args;
  return args.length === expected.length && args.every((a, i) => a === expected[i]);
}

export function cliClient(spec: CliClientSpec): ClientAdapter {
  const scopes: readonly Scope[] = spec.projectRel ? ["user", "project"] : ["user"];
  const isOurs = spec.isOurs ?? isAssayEntry;

  function target(scope: Scope, env: ClientEnv): Target {
    if (scope === "user") return { scope, configPath: spec.userPath(env), projectRoot: null };
    if (!spec.projectRel) throw new ClientError(`${spec.label} has no project scope`);
    const configPath = projectConfigPath(env.cwd, spec.projectRel);
    return { scope, configPath, projectRoot: projectRootOf(configPath, spec.projectRel) };
  }

  function cwdOf(t: Target, env: ClientEnv): string {
    if (t.scope === "user") return env.home;
    if (t.projectRoot === null || !spec.projectRel) throw new ClientError(`${spec.label} has no project scope`);
    // Recheck containment right before the client writes.
    projectConfigPath(t.projectRoot, spec.projectRel);
    return t.projectRoot;
  }

  return {
    id: spec.id,
    label: spec.label,
    kind: "cli",
    bin: spec.bin,
    scopes,
    target,
    targetOf(scope, configPath, env) {
      if (scope === "user") {
        if (configPath !== spec.userPath(env)) throw new ClientError(`${configPath} is not ${spec.label}'s config`);
        return { scope, configPath, projectRoot: null };
      }
      const root = spec.projectRel ? projectRootOf(configPath, spec.projectRel) : null;
      if (root === null || !spec.projectRel) throw new ClientError(`${configPath} is not a ${spec.label} project config`);
      return { scope, configPath: projectConfigPath(root, spec.projectRel), projectRoot: root };
    },
    entries(t) {
      return spec.read(t.configPath);
    },
    isOurs,
    async install(t, input, { force }, env) {
      const cwd = cwdOf(t, env);
      if (spec.read(t.configPath).has(input.name)) {
        if (!force) throw new ClientError(`${spec.label} already has a server named "${input.name}"; pass --force to replace it`);
        await env.run(spec.bin, spec.removeArgv(input.name, t.scope), { cwd });
      }
      const { bin, argv } = cliInvocation(spec.id, input, t.scope);
      await env.run(bin, argv, { cwd });
      const written = spec.read(t.configPath).get(input.name);
      if (!sameArgs(isOurs, written, serverEntry(spec.id, input, t.scope).args)) {
        throw new ClientError(`${spec.label} did not write the expected entry to ${t.configPath}; check it with \`assay-mcp list\``);
      }
    },
    async uninstall(t, name, env) {
      const current = spec.read(t.configPath);
      if (!current.has(name)) return;
      if (!isOurs(current.get(name))) throw new ClientError(`${spec.label}'s "${name}" is not the entry assay-mcp wrote; left unchanged`);
      await env.run(spec.bin, spec.removeArgv(name, t.scope), { cwd: cwdOf(t, env) });
      if (spec.read(t.configPath).has(name)) throw new ClientError(`${spec.label} still lists "${name}"`);
    },
  };
}

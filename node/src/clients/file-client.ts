/** A client whose MCP servers live in one JSON file under one key (`mcpServers` or `servers`). */
import type { ClientAdapter, ClientEnv, Target } from "./client.js";
import { ClientError } from "./client.js";
import { projectConfigPath, projectRootOf, readJsonDoc, section, writeJsonDoc } from "./config-file.js";
import { isExactAssayEntry, serverEntry, type ClientId, type Scope } from "./install-command.js";

export interface FileClientSpec {
  id: ClientId;
  label: string;
  /** The JSON key that holds the servers. */
  key: "mcpServers" | "servers";
  /** The user-scope config path. */
  userPath(env: ClientEnv): string;
  /** The project-scope path relative to the project root, when the client has one. */
  projectRel?: string;
}

export function fileClient(spec: FileClientSpec): ClientAdapter {
  // Exactly what `install` stores: VS Code keeps `type`, the others only command and args.
  const ourKeys = spec.id === "vscode" ? ["type", "command", "args"] : ["command", "args"];
  const isOurs = (entry: unknown): boolean => isExactAssayEntry(entry, ourKeys);
  const scopes: readonly Scope[] = spec.projectRel ? ["user", "project"] : ["user"];

  function target(scope: Scope, env: ClientEnv): Target {
    if (scope === "user") return { scope, configPath: spec.userPath(env), projectRoot: null };
    if (!spec.projectRel) throw new ClientError(`${spec.label} has no project scope`);
    const configPath = projectConfigPath(env.cwd, spec.projectRel);
    return { scope, configPath, projectRoot: projectRootOf(configPath, spec.projectRel) };
  }

  function targetOf(scope: Scope, configPath: string, env: ClientEnv): Target {
    if (scope === "user") {
      const expected = spec.userPath(env);
      if (configPath !== expected) throw new ClientError(`${configPath} is not ${spec.label}'s config`);
      return { scope, configPath, projectRoot: null };
    }
    const root = spec.projectRel ? projectRootOf(configPath, spec.projectRel) : null;
    if (root === null || !spec.projectRel) throw new ClientError(`${configPath} is not a ${spec.label} project config`);
    return { scope, configPath: projectConfigPath(root, spec.projectRel), projectRoot: root };
  }

  function entries(t: Target): Map<string, unknown> {
    const doc = readJsonDoc(t.configPath);
    const servers = doc.data[spec.key];
    if (servers === undefined) return new Map();
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      throw new ClientError(`${t.configPath}: "${spec.key}" is not an object`);
    }
    return new Map(Object.entries(servers));
  }

  return {
    id: spec.id,
    label: spec.label,
    kind: "file",
    scopes,
    target,
    targetOf,
    entries,
    isOurs,
    async install(t, input, { force }) {
      const doc = readJsonDoc(t.configPath);
      const servers = section(doc, spec.key, t.configPath);
      if (Object.hasOwn(servers, input.name) && !force) {
        throw new ClientError(`${spec.label} already has a server named "${input.name}"; pass --force to replace it`);
      }
      const entry = serverEntry(spec.id, input, t.scope);
      // vscode keeps `type`; the others store only command and args.
      servers[input.name] = { ...entry, args: [...entry.args] };
      writeJsonDoc(t.configPath, doc, { newFileMode: t.scope === "project" ? 0o644 : 0o600 });
    },
    async uninstall(t, name) {
      const doc = readJsonDoc(t.configPath);
      const servers = section(doc, spec.key, t.configPath);
      if (!Object.hasOwn(servers, name)) return;
      if (!isOurs(servers[name])) throw new ClientError(`${spec.label}'s "${name}" is not the entry assay-mcp wrote; left unchanged`);
      delete servers[name];
      writeJsonDoc(t.configPath, doc, { newFileMode: 0o600 });
    },
  };
}

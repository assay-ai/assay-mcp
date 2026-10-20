import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isValidName } from "../clients/server-name.js";
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from "../exit-codes.js";
import { openLogFile, LogFileError, type LogFile } from "../log/log-file.js";
import { createLogger, DEFAULT_LOG_LEVEL, parseLogLevel, type Logger, type LogLevel } from "../log/logger.js";
import { pinnedFetch } from "../net/fetch.js";
import { ApiKeyError, apiKey as apiKeyOf } from "../oauth/api-key.js";
import { openBrowser, signIn } from "../oauth/flow.js";
import { OriginError, resolveDeployment, type ResolvedDeployment } from "../profile/deployments.js";
import { readDevOrigins } from "../profile/dev-origins.js";
import { KeychainError, openOsKeychain, reportKeychainError, type OsKeychain } from "../profile/keychain.js";
import type { LockOptions, ProfileRef } from "../profile/lock.js";
import { configDir, isValidProfileName } from "../profile/paths.js";
import { checkEnvironment, readProfileSettings } from "../proxy/environment.js";
import { createChainReader } from "../chain/reads.js";
import { QuoteCache } from "../guards/quote-cache.js";
import { PaidPath } from "../proxy/paid.js";
import { Proxy } from "../proxy/proxy.js";
import { readLines, StdoutWriter } from "../proxy/stdio.js";

/**
 * `assay-mcp serve`: the stdio MCP proxy (spec §7.3, §7.6; R-MCP-3, R-MCP-4, R-MCP-15).
 *
 * Startup, in order; any failure is exit 1 with one line on stderr and nothing on stdout:
 * 1. flags (exit 2 on a usage error);
 * 2. the environment checks (2.4-N1: TLS off and env proxies refused, extra CAs warned);
 * 3. the log sinks (stderr, and `--log-file`, which must be an absolute path);
 * 4. the deployment: built-in only, dev mode only through env plus the TTY-written file;
 * 5. the OS keychain probe (§7.9);
 * 6. the proxy, until stdin ends (exit 0).
 * After startup nothing exits the process on a network error: failures are JSON-RPC answers.
 * Nothing here reads the working directory or `PATH` (a project config can set both).
 */

export interface ServeFlags {
  url: string | undefined;
  profile: string;
  name: string | null;
  noPaid: boolean;
  logLevel: LogLevel;
  logFile: string | null;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set(["--url", "--profile", "--name", "--no-paid", "--log-level", "--log-file"]);

export function parseServeArgs(args: readonly string[]): ServeFlags | { error: string } {
  const flags: ServeFlags = { url: undefined, profile: "default", name: null, noPaid: false, logLevel: DEFAULT_LOG_LEVEL, logFile: null };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const key = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq !== -1 ? arg.slice(eq + 1) : undefined;
    // As `parseFlags` does for every other command: a flag given twice is a usage error.
    if (KNOWN_FLAGS.has(key)) {
      if (seen.has(key)) return { error: `${key} is given more than once` };
      seen.add(key);
    }
    const value = (): string | null => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i++;
      return next;
    };
    switch (key) {
      case "--url": {
        const v = value();
        if (v === null) return { error: "--url needs a value" };
        flags.url = v;
        break;
      }
      case "--profile": {
        const v = value();
        if (v === null || !isValidProfileName(v)) return { error: "--profile must be a-z, 0-9 and -, up to 32 characters" };
        flags.profile = v;
        break;
      }
      case "--name": {
        const v = value();
        if (v === null || !isValidName(v)) return { error: "--name must match ^[a-z][a-z0-9-]*$ (at most 56 characters)" };
        flags.name = v;
        break;
      }
      case "--no-paid":
        if (inline !== undefined) return { error: "--no-paid takes no value" };
        flags.noPaid = true;
        break;
      case "--log-level": {
        const v = value();
        const level = v === null ? null : parseLogLevel(v);
        if (level === null) return { error: "--log-level must be error, warn, info or debug" };
        flags.logLevel = level;
        break;
      }
      case "--log-file": {
        const v = value();
        if (v === null) return { error: "--log-file needs a value" };
        if (!isAbsolute(v)) return { error: "--log-file must be an absolute path" };
        flags.logFile = v;
        break;
      }
      default:
        return { error: `unknown option "${arg.slice(0, 64)}"` };
    }
  }
  return flags;
}

/** What `serve` uses from its surroundings; tests replace them, production passes nothing. */
export interface ServeDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execArgv?: readonly string[];
  readonly configDir?: string;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: (line: string) => void;
  readonly openKeychain?: () => Promise<OsKeychain>;
  /** Replaces the real browser launcher (tests). */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  readonly lockOptions?: LockOptions;
  readonly requestTimeoutMs?: number;
  readonly grantPollMs?: number;
  readonly signInTimeoutMs?: number;
  /** The enable-paid poll interval and bound (tests shorten them). */
  readonly paidPollMs?: number;
  readonly paidPollMaxMs?: number;
}

/** How long answers still in flight may take once stdin has ended. */
const DRAIN_MS = 5_000;

export async function serve(args: readonly string[], deps: ServeDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((line: string) => void process.stderr.write(line));
  const env = deps.env ?? process.env;
  const parsed = parseServeArgs(args);
  if ("error" in parsed) {
    stderr(`assay-mcp: ${parsed.error}\n`);
    return EXIT_USAGE;
  }
  const dir = deps.configDir ?? configDir();
  const profile: ProfileRef = { dir, name: parsed.profile };

  const verdict = checkEnvironment(env, deps.execArgv ?? process.execArgv, () => readProfileSettings(profile), profile.name);
  for (const w of verdict.warnings) stderr(`assay-mcp: warning: ${w}\n`);
  if (verdict.refusals.length > 0) {
    for (const r of verdict.refusals) stderr(`assay-mcp: ${r}\n`);
    return EXIT_FATAL;
  }

  let logFile: LogFile | null = null;
  try {
    if (parsed.logFile !== null) logFile = openLogFile(parsed.logFile);
  } catch (err) {
    stderr(`assay-mcp: ${err instanceof LogFileError ? err.message : "cannot open the log file"}\n`);
    return EXIT_FATAL;
  }
  const log: Logger = createLogger({ level: parsed.logLevel, component: "serve", file: logFile, stderr });

  try {
    let deployment: ResolvedDeployment;
    try {
      deployment = resolveDeployment({ url: parsed.url, env, devOrigins: readDevOrigins(dir), warn: stderr });
    } catch (err) {
      if (err instanceof OriginError) {
        stderr(`assay-mcp: ${err.message}\n`);
        return EXIT_FATAL;
      }
      throw err;
    }

    let key: string | null;
    try {
      key = apiKeyOf(deployment, env);
    } catch (err) {
      if (err instanceof ApiKeyError) {
        stderr(`assay-mcp: ${err.message}\n`);
        return EXIT_FATAL;
      }
      throw err;
    }

    let os: OsKeychain;
    try {
      os = await (deps.openKeychain ?? openOsKeychain)();
      await os.probe();
    } catch (err) {
      if (err instanceof KeychainError) return reportKeychainError(err, stderr);
      throw err;
    }
    const keychain = os.forScope({ profile: profile.name, environment: deployment.environment });
    const browser = deps.openBrowser ?? ((url: string) => openBrowser(deployment, url));

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const writer = new StdoutWriter(deps.stdout ?? process.stdout, () => resolveDone());
    const proxy = new Proxy({
      deployment,
      profile,
      keychain,
      apiKey: key,
      serverName: parsed.name,
      writer,
      stderr,
      fetch: (url, init) => pinnedFetch(deployment, url, init),
      openBrowser: browser,
      signIn: (hooks) =>
        signIn(profile, deployment, { passive: hooks.passive }, {
          keychain,
          log,
          onLink: hooks.onLink,
          openBrowser: hooks.openBrowser,
          signal: hooks.signal,
          onMarker: hooks.onMarker,
          ...(deps.lockOptions ? { lockOptions: deps.lockOptions } : {}),
          ...(deps.signInTimeoutMs !== undefined ? { timeoutMs: deps.signInTimeoutMs } : {}),
        }),
      log,
      ...(deps.lockOptions ? { lockOptions: deps.lockOptions } : {}),
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      ...(deps.grantPollMs !== undefined ? { grantPollMs: deps.grantPollMs } : {}),
      paid: (host) =>
        new PaidPath(
          {
            deployment,
            profile,
            keychain,
            noPaid: parsed.noPaid,
            // A project-scope entry never carries --name (R-MU-4); it pays only through explicitly allowed URLs.
            projectForm: parsed.name === null,
            chain: createChainReader({ environment: deployment.environment, profile: profile.name }),
            quotes: new QuoteCache(),
            fetch: (url, init) => pinnedFetch(deployment, url, init),
            openBrowser: browser,
            stderr,
            log,
            ...(deps.lockOptions ? { lockOptions: deps.lockOptions } : {}),
            ...(deps.paidPollMs !== undefined ? { pollMs: deps.paidPollMs } : {}),
            ...(deps.paidPollMaxMs !== undefined ? { pollMaxMs: deps.paidPollMaxMs } : {}),
          },
          host,
        ),
    });
    if (parsed.noPaid) log.info("paid calls are off for this server (--no-paid)");

    await proxy.start();
    readLines(
      deps.stdin ?? process.stdin,
      (e) => (e.kind === "line" ? proxy.handleLine(e.text) : proxy.handleOversized()),
      () => resolveDone(),
    );
    await done;
    await proxy.drain(DRAIN_MS);
    proxy.stop();
    await writer.flush();
    return EXIT_OK;
  } finally {
    logFile?.close();
  }
}

/**
 * The `serve` command. After the proxy ran (stdin ended, stdout flushed) the process ends
 * at once: a pending sign-in or lock heartbeat must not keep it alive.
 */
export async function run(args: readonly string[]): Promise<number> {
  // A host that kills the server: exit through process.exit so the exit hooks release a
  // held lock and the sign-in marker (review M6).
  for (const [signal, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]] as const) process.once(signal, () => process.exit(128 + n));
  const code = await serve(args);
  if (code === EXIT_OK) process.exit(EXIT_OK);
  return code;
}

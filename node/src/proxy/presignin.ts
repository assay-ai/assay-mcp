import { SIGN_IN_TOOL } from "../clients/server-name.js";
import { VERSION } from "../version.js";
import { METHOD_NOT_FOUND, negotiateVersion, type JsonRpcError, type ProtocolVersion } from "./protocol.js";

/**
 * Pre-sign-in mode (spec §7.6, R-MCP-4, BL-3): what the proxy answers by itself.
 *
 * `initialize` is always answered here, signed in or not. Without a credential, `tools/list`
 * offers the one local tool `assay_sign_in`; calling it (or any tool) starts F1 and returns
 * the link; `resources/*` and `prompts/*` are empty.
 */

export const INSTRUCTIONS = "If Assay tools are missing, call assay_sign_in.";
export const SIGN_IN_DESCRIPTION = "Connect Assay. Opens your browser to approve, and returns the link.";

export const SIGN_IN_TOOL_DEFINITION = Object.freeze({
  name: SIGN_IN_TOOL,
  description: SIGN_IN_DESCRIPTION,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

/** §7.6 step 3. */
export function signInText(link: string, app: string): string {
  return `Approve in your browser: ${link}. Assay tools appear here when you're done (if they don't, restart ${app}).`;
}

/** The host's name for `{app}`: its `clientInfo` title or name, printable and short, else "your app". */
export function appName(clientInfo: unknown): string {
  if (typeof clientInfo !== "object" || clientInfo === null) return "your app";
  const info = clientInfo as Record<string, unknown>;
  for (const candidate of [info.title, info.name]) {
    if (typeof candidate !== "string") continue;
    const clean = candidate.replace(/[^A-Za-z0-9 ._()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
    if (/[A-Za-z0-9]/.test(clean)) return clean;
  }
  return "your app";
}

export interface InitializeOutcome {
  readonly version: ProtocolVersion;
  readonly result: Record<string, unknown>;
}

/** §7.6 step 1: the local `initialize` answer. */
export function answerInitialize(params: Record<string, unknown> | undefined): InitializeOutcome {
  const version = negotiateVersion(params?.protocolVersion);
  return {
    version,
    result: {
      protocolVersion: version,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "assay", version: VERSION },
      instructions: INSTRUCTIONS,
    },
  };
}

/** Empty answers for the other methods of this mode (§7.6 step 6). */
const EMPTY: Readonly<Record<string, () => Record<string, unknown>>> = {
  ping: () => ({}),
  "resources/list": () => ({ resources: [] }),
  "resources/templates/list": () => ({ resourceTemplates: [] }),
  "resources/read": () => ({ contents: [] }),
  "prompts/list": () => ({ prompts: [] }),
  "prompts/get": () => ({ messages: [] }),
  "completion/complete": () => ({ completion: { values: [], hasMore: false } }),
  "logging/setLevel": () => ({}),
};

/**
 * The local answer for a request other than `initialize` and `tools/call` while signed out:
 * a result, or a JSON-RPC error.
 */
export function answerSignedOut(method: string): { result: Record<string, unknown> } | { error: JsonRpcError } {
  if (method === "tools/list") return { result: { tools: [{ ...SIGN_IN_TOOL_DEFINITION }] } };
  const empty = EMPTY[method];
  if (empty) return { result: empty() };
  return { error: { code: METHOD_NOT_FOUND, message: "Method not found" } };
}

/** §7.6 step 3 when another process's sign-in is pending (Task 2.8 fix round 1). */
export function signInBusyText(app: string): string {
  return `Assay sign-in is already in progress in another window. Approve it there; Assay tools appear here when you're done (if they don't, restart ${app}).`;
}

export interface SignInHooks {
  /** Called with the authorize link as soon as it exists. */
  readonly onLink: (link: string) => void;
  /** Called by the flow when it would open the browser; returns whether it was opened. */
  readonly openBrowser: (link: string) => Promise<boolean>;
  /** A link-only (startup) sign-in. */
  readonly passive: boolean;
  /** Cancels the wait for the browser. */
  readonly signal: AbortSignal;
  /** Receives the function that marks a passive sign-in active (false: taken over elsewhere). */
  readonly onMarker: (activate: () => Promise<boolean>) => void;
}

/**
 * Runs at most one F1 sign-in at a time in this process and decides when the browser opens:
 * a sign-in started at startup only prints its link (§7.6 step 4) and is passive; the first
 * `assay_sign_in` call opens it (step 3), once, and marks it active.
 */
export class SignInController {
  private running: {
    link: Promise<string>;
    passive: boolean;
    opening: Promise<string> | null;
    abort: AbortController;
    activate: (() => Promise<boolean>) | null;
  } | null = null;

  constructor(
    private readonly start: (hooks: SignInHooks) => Promise<void>,
    private readonly open: (link: string) => Promise<boolean>,
    /** The error for a sign-in another process took over. */
    private readonly busy: () => Error,
  ) {}

  get active(): boolean {
    return this.running !== null;
  }

  /** Stops waiting for the browser (a grant arrived some other way). */
  cancel(): void {
    this.running?.abort.abort();
  }

  /**
   * Starts a sign-in, or joins the one running. Resolves with the link; rejects when the
   * sign-in could not start (`LOCK_TIMEOUT`, another process's sign-in, a stored grant).
   * `openBrowser`: open it now (a passive sign-in is first marked active, which fails when
   * another process took it over).
   */
  begin(openBrowser: boolean): Promise<string> {
    const current = this.running;
    if (current) {
      if (!openBrowser || !current.passive) return current.opening ?? current.link;
      current.opening ??= (async () => {
        const link = await current.link;
        if (!(await (current.activate?.() ?? Promise.resolve(false)))) {
          current.abort.abort();
          throw this.busy();
        }
        void this.open(link).catch(() => false);
        return link;
      })();
      current.opening.catch(() => {});
      return current.opening;
    }
    let resolveLink!: (l: string) => void;
    let rejectLink!: (e: unknown) => void;
    const link = new Promise<string>((res, rej) => {
      resolveLink = res;
      rejectLink = rej;
    });
    link.catch(() => {}); // observed by whoever awaits it; never an unhandled rejection
    const state = { link, passive: !openBrowser, opening: null as Promise<string> | null, abort: new AbortController(), activate: null as (() => Promise<boolean>) | null };
    this.running = state;
    const hooks: SignInHooks = {
      passive: !openBrowser,
      signal: state.abort.signal,
      onMarker: (activate) => {
        state.activate = activate;
      },
      onLink: (l) => resolveLink(l),
      // An active sign-in opens at once; a passive one only printed its link (opened later by `begin(true)`).
      openBrowser: async (l) => (state.passive ? true : this.open(l).catch(() => false)),
    };
    this.start(hooks)
      .catch((err: unknown) => {
        rejectLink(err);
      })
      .finally(() => {
        if (this.running === state) this.running = null;
        rejectLink(new Error("the sign-in ended"));
      });
    return link;
  }
}

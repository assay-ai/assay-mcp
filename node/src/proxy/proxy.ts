import { SIGN_IN_TOOL } from "../clients/server-name.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { identifyCredential, SignInError, type SignInResult } from "../oauth/flow.js";
import { currentAccess, hasGrant, RefreshError, refreshUnderLock, type TokenContext } from "../oauth/tokens.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import { KeychainError, type Keychain } from "../profile/keychain.js";
import { LockError, withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, readProfileFor, updateProfile } from "../profile/profile.js";
import { AliasTable } from "./aliases.js";
import { CallRegistry, type ForwardedCall } from "./calls.js";
import { Forwarder, type FetchLike, type Outcome } from "./forwarder.js";
import { answerInitialize, answerSignedOut, appName, SignInController, signInText, type SignInHooks } from "./presignin.js";
import {
  classify,
  envelopeVersion,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isModernVersion,
  LOCK_BUSY,
  MESSAGES,
  NEWEST_LEGACY_VERSION,
  PARSE_ERROR,
  resultResponse,
  SERVER_ERROR,
  UNREACHABLE,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProtocolVersion,
} from "./protocol.js";
import type { StdoutWriter } from "./stdio.js";

/**
 * The proxy core (spec §7.6): one host on stdio, one Assay MCP URL over HTTP.
 *
 * Modes:
 * - **pre-sign-in** (no API key, no grant, or after `invalid_grant`): answered locally
 *   (`presignin.ts`); the sign-in link goes to stderr at startup, the browser opens on the
 *   first `assay_sign_in` call; when a token arrives (this process's sign-in, or a sibling's
 *   seen in the keychain) the host gets `notifications/tools/list_changed`.
 * - **signed-in**: every host request and notification is forwarded (`forwarder.ts`) with the
 *   host's own bytes, except a `tools/call` on an alias, which is sent with the exact original
 *   name. A 401 refreshes under the lock and retries once; if that fails, the proxy goes back
 *   to pre-sign-in mode and sends `list_changed`.
 *
 * Nothing here throws to the event loop: every failure is a JSON-RPC answer or a log line.
 */

export type Mode = "pre-sign-in" | "signed-in";

/** The paid-path hook (Task 2.9): sees each `tools/call` answer with its call record. */
export type ToolResultHook = (call: ForwardedCall, response: JsonRpcResponse) => Promise<JsonRpcResponse>;

export interface ProxyOptions {
  readonly deployment: ResolvedDeployment;
  readonly profile: ProfileRef;
  readonly keychain: Keychain;
  /** `ASSAY_API_KEY` (or the dev key), already validated; `null` for OAuth. */
  readonly apiKey: string | null;
  /** `--name`, or `null`. */
  readonly serverName: string | null;
  readonly writer: StdoutWriter;
  /** stderr, for the sign-in link (never stdout). */
  readonly stderr: (line: string) => void;
  /** F1 (`oauth/flow.ts` `signIn` with the process's keychain and lock options). */
  readonly signIn: (hooks: SignInHooks) => Promise<SignInResult>;
  /** Opens the browser on a link this process built (`oauth/flow.ts` `openBrowser`). */
  readonly openBrowser: (url: string) => Promise<boolean>;
  /** `pinnedFetch` bound to the deployment. */
  readonly fetch: FetchLike;
  readonly log?: Logger;
  readonly lockOptions?: LockOptions;
  readonly requestTimeoutMs?: number;
  /** How often a signed-out process looks for a grant a sibling stored. Default 10 s. */
  readonly grantPollMs?: number;
  readonly onToolResult?: ToolResultHook;
}

const CREDENTIAL_RETRY_MS = 60_000;

type Bearer = { token: string } | { signedOut: true } | { error: { code: number; message: string } };

export class Proxy {
  private mode: Mode = "pre-sign-in";
  private hostVersion: ProtocolVersion | null = null;
  private app = "your app";
  private remoteInit: Promise<Outcome> | null = null;
  /** A refresh token the server refused while it was still stored: not a new sign-in. */
  private rejectedRefresh: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private credentialChecked = false;
  private credentialAttemptAt = 0;
  private credentialRunning = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly log: Logger;
  private readonly forwarder: Forwarder;
  private readonly aliases: AliasTable;
  private readonly signIns: SignInController;
  readonly calls = new CallRegistry();

  constructor(private readonly o: ProxyOptions) {
    this.log = (o.log ?? silentLogger).child("proxy");
    this.forwarder = new Forwarder({
      url: o.deployment.url,
      fetch: o.fetch,
      log: o.log ?? silentLogger,
      ...(o.requestTimeoutMs !== undefined ? { timeoutMs: o.requestTimeoutMs } : {}),
    });
    this.aliases = new AliasTable(o.serverName, o.log ?? silentLogger);
    this.signIns = new SignInController((hooks) => this.runSignIn(hooks), (url) => o.openBrowser(url));
  }

  get currentMode(): Mode {
    return this.mode;
  }

  private get tokens(): TokenContext {
    return {
      profile: this.o.profile,
      deployment: this.o.deployment,
      keychain: this.o.keychain,
      log: this.o.log ?? silentLogger,
      ...(this.o.lockOptions ? { lockOptions: this.o.lockOptions } : {}),
    };
  }

  /** Decides the starting mode; signed out, starts F1 and prints its link to stderr. */
  async start(): Promise<void> {
    if (this.o.apiKey !== null) {
      this.mode = "signed-in";
      return;
    }
    let granted = false;
    try {
      granted = await hasGrant(this.tokens);
    } catch (err) {
      this.log.warn("keychain read failed", { error: errorName(err) });
    }
    if (granted) {
      this.mode = "signed-in";
      return;
    }
    this.enterSignedOut(false);
    this.signIns.begin(false).then(
      (link) => this.o.stderr(`assay-mcp: sign in to Assay: ${link}\n`),
      (err: unknown) => this.log.info("sign-in not started at startup", { error: errorName(err) }),
    );
  }

  /** Stops timers. Pending answers are left to {@link drain}. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Waits for answers still in flight, at most `maxMs`. */
  async drain(maxMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((r) => {
        timer = setTimeout(r, maxMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // ---- host input ---------------------------------------------------------------------

  /** One line from stdin. */
  handleLine(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.o.writer.send(errorResponse(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (Array.isArray(parsed)) {
      // §7.6: batches are split and sent one by one.
      if (parsed.length === 0) this.o.writer.send(errorResponse(null, INVALID_REQUEST, "Invalid Request"));
      for (const item of parsed) this.handleMessage(item, JSON.stringify(item));
      return;
    }
    this.handleMessage(parsed, text);
  }

  /** A line longer than the stdin limit. */
  handleOversized(): void {
    this.o.writer.send(errorResponse(null, INVALID_REQUEST, "Message too large."));
  }

  private handleMessage(value: unknown, raw: string): void {
    const c = classify(value);
    switch (c.kind) {
      case "response":
        return; // §7.6: host responses to server requests are dropped
      case "invalid": {
        const isResponseShape = typeof value === "object" && value !== null && !("method" in value);
        if (!isResponseShape) this.o.writer.send(errorResponse(c.id, INVALID_REQUEST, "Invalid Request"));
        return;
      }
      case "notification":
        this.track(this.handleNotification(c.message, raw));
        return;
      case "request": {
        const req = c.message;
        this.track(
          this.handleRequest(req, raw)
            .catch((err: unknown) => {
              this.log.error("request failed", { method: req.method, error: errorName(err) });
              return errorResponse(req.id, INTERNAL_ERROR, "Internal error");
            })
            .then((response) => this.o.writer.send(response)),
        );
        return;
      }
    }
  }

  private track(p: Promise<unknown>): void {
    const guarded = p.catch((err: unknown) => this.log.error("unexpected failure", { error: errorName(err) }));
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  private async handleNotification(n: JsonRpcNotification, raw: string): Promise<void> {
    if (n.method === "notifications/initialized") return; // the proxy sends its own upstream
    if (this.mode !== "signed-in") return;
    const bearer = await this.bearer();
    if (!("token" in bearer)) return;
    const envelope = envelopeVersion(n);
    const version = envelope ?? this.legacyVersion();
    if (envelope === null && (await this.handshake(bearer.token, version)).kind !== "response") return;
    const outcome = await this.forwarder.send({ id: null, body: raw, bearer: bearer.token, version });
    if (outcome.kind === "error") this.log.info("notification not delivered", { method: n.method, code: outcome.code });
  }

  private async handleRequest(req: JsonRpcRequest, raw: string): Promise<JsonRpcResponse> {
    if (req.method === "initialize") {
      const { version, result } = answerInitialize(req.params);
      this.hostVersion = version;
      this.app = appName(req.params?.clientInfo);
      return resultResponse(req.id, result);
    }
    if (this.mode === "pre-sign-in") await this.lookForGrant();
    if (this.mode === "pre-sign-in") return this.answerSignedOut(req);
    return this.forward(req, raw);
  }

  // ---- pre-sign-in ----------------------------------------------------------------------

  private async answerSignedOut(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (req.method !== "tools/call") {
      const local = answerSignedOut(req.method);
      return "result" in local ? resultResponse(req.id, local.result) : { jsonrpc: "2.0", id: req.id, error: local.error };
    }
    // §7.6 step 3: assay_sign_in, or any other tool, starts F1 and opens the browser.
    let link: string;
    try {
      link = await this.signIns.begin(true);
    } catch (err) {
      if (err instanceof LockError && err.code === "LOCK_TIMEOUT") return errorResponse(req.id, LOCK_BUSY, MESSAGES.lockBusy);
      if (err instanceof KeychainError) return errorResponse(req.id, SERVER_ERROR, err.message);
      this.log.warn("sign-in could not start", { error: errorName(err) });
      return errorResponse(req.id, SERVER_ERROR, "The sign-in could not start. Try again.");
    }
    const tool = typeof req.params?.name === "string" ? req.params.name : "";
    return resultResponse(req.id, {
      content: [{ type: "text", text: signInText(link, this.app) }],
      ...(tool === SIGN_IN_TOOL ? {} : { isError: true }),
    });
  }

  private async runSignIn(hooks: SignInHooks): Promise<void> {
    let result: SignInResult;
    try {
      result = await this.o.signIn(hooks);
    } catch (err) {
      if (err instanceof SignInError) this.log.warn("sign-in did not complete", { reason: err.reason });
      else this.log.warn("sign-in failed", { error: errorName(err) });
      throw err;
    }
    this.rejectedRefresh = null;
    this.credentialChecked = result.credentialId !== null;
    this.credentialAttemptAt = 0;
    this.enterSignedIn();
  }

  /** A signed-out process picks up a grant another process (or `login`) stored. */
  private async lookForGrant(): Promise<void> {
    if (this.o.apiKey !== null || this.mode !== "pre-sign-in" || this.signIns.active) return;
    let refresh: string | null;
    try {
      refresh = await this.o.keychain.get("refresh_token");
    } catch {
      return;
    }
    if (refresh !== null && refresh !== this.rejectedRefresh) {
      this.credentialChecked = false;
      this.enterSignedIn();
    }
  }

  private enterSignedIn(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const changed = this.mode !== "signed-in";
    this.mode = "signed-in";
    this.remoteInit = null;
    this.forwarder.reset();
    if (changed) this.sendListChanged();
  }

  private enterSignedOut(notify: boolean): void {
    const changed = this.mode !== "pre-sign-in";
    this.mode = "pre-sign-in";
    this.remoteInit = null;
    this.forwarder.reset();
    if (!this.pollTimer && this.o.apiKey === null) {
      this.pollTimer = setInterval(() => void this.lookForGrant().catch(() => {}), this.o.grantPollMs ?? 10_000);
      this.pollTimer.unref();
    }
    if (notify && changed) this.sendListChanged();
  }

  private sendListChanged(): void {
    this.o.writer.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  // ---- signed-in ------------------------------------------------------------------------

  private legacyVersion(): string {
    return this.hostVersion !== null && !isModernVersion(this.hostVersion) ? this.hostVersion : NEWEST_LEGACY_VERSION;
  }

  private async bearer(): Promise<Bearer> {
    if (this.o.apiKey !== null) return { token: this.o.apiKey };
    try {
      const token = await currentAccess(this.tokens);
      return token === null ? { signedOut: true } : { token };
    } catch (err) {
      return { error: tokenError(err, this.log) };
    }
  }

  private async refreshed(failed: string): Promise<Bearer> {
    try {
      const token = await refreshUnderLock(this.tokens, failed);
      return token === null ? { signedOut: true } : { token };
    } catch (err) {
      return { error: tokenError(err, this.log) };
    }
  }

  /** The current refresh token, remembered as refused (a 401 even after a refresh). */
  private async rememberRefused(): Promise<void> {
    try {
      this.rejectedRefresh = await this.o.keychain.get("refresh_token");
    } catch {
      this.rejectedRefresh = null;
    }
  }

  private async forward(req: JsonRpcRequest, raw: string): Promise<JsonRpcResponse> {
    let body = raw;
    let call: ForwardedCall | null = null;
    if (req.method === "tools/call") {
      const name = typeof req.params?.name === "string" ? req.params.name : null;
      if (name === SIGN_IN_TOOL && !this.aliases.isAlias(name)) {
        return resultResponse(req.id, { content: [{ type: "text", text: "Assay is connected. Its tools are listed here." }] });
      }
      const original = name === null ? null : this.aliases.original(name);
      const params = req.params ?? {};
      if (original !== null && original !== name) {
        // A call on an alias goes out with the exact original name.
        const rewritten = { ...params, name: original };
        body = JSON.stringify({ ...req, params: rewritten });
        call = this.calls.begin(req.id, original, rewritten);
      } else {
        call = this.calls.begin(req.id, original ?? "", params);
      }
      if (call === null) return errorResponse(req.id, INVALID_REQUEST, "A request with this id is already in flight.");
    }
    try {
      const response = await this.exchange(req, body);
      if (response === "signed-out") return this.answerSignedOut(req);
      return call !== null && this.o.onToolResult ? await this.o.onToolResult(call, response) : response;
    } finally {
      if (call !== null) this.calls.end(call);
    }
  }

  /** Sends one request: token, lazy handshake, 401 refresh-and-retry-once. */
  private async exchange(req: JsonRpcRequest, body: string): Promise<JsonRpcResponse | "signed-out"> {
    let bearer = await this.bearer();
    for (let attempt = 0; ; attempt++) {
      if ("signedOut" in bearer) {
        this.enterSignedOut(true);
        return "signed-out";
      }
      if ("error" in bearer) return errorResponse(req.id, bearer.error.code, bearer.error.message);
      const token = bearer.token;

      const envelope = envelopeVersion(req);
      const version = envelope ?? this.legacyVersion();
      let outcome: Outcome = envelope === null ? await this.handshake(token, version) : { kind: "accepted" };
      if (outcome.kind !== "unauthorized" && outcome.kind !== "error") {
        outcome = await this.forwarder.send({ id: req.id, body, bearer: token, version, onNotification: (n) => this.o.writer.send(n) });
      }
      if (outcome.kind === "unauthorized") {
        if (this.o.apiKey !== null) return errorResponse(req.id, SERVER_ERROR, "Assay refused the API key in the environment.");
        if (attempt > 0) {
          // Refused even with a fresh token: back to sign-in.
          await this.rememberRefused();
          this.enterSignedOut(true);
          return "signed-out";
        }
        this.remoteInit = null;
        bearer = await this.refreshed(token);
        continue;
      }
      if (outcome.kind === "error") return errorResponse(req.id, outcome.code, outcome.message);
      if (outcome.kind === "accepted") return errorResponse(req.id, SERVER_ERROR, "Assay sent no answer.");
      this.checkCredentialSoon(token);
      return this.rewrite(req, outcome.response);
    }
  }

  /** The 2025-era remote `initialize`, once per sign-in (lazily, before the first request). */
  private async handshake(token: string, version: string): Promise<Outcome> {
    if (!this.remoteInit) {
      const p = this.forwarder.initialize(token, version);
      this.remoteInit = p;
      void p.then((o) => {
        if (o.kind !== "response" && this.remoteInit === p) this.remoteInit = null;
      });
    }
    return this.remoteInit;
  }

  private rewrite(req: JsonRpcRequest, response: JsonRpcResponse): JsonRpcResponse {
    const base = { jsonrpc: "2.0" as const, id: req.id };
    if ("error" in response) return { ...base, error: response.error };
    if (req.method === "tools/list") {
      return { ...base, result: this.aliases.rewriteList(response.result, req.params?.cursor === undefined) };
    }
    return { ...base, result: response.result };
  }

  /**
   * Reads the credential id back when the profile does not hold it yet (2.7: the sign-in may
   * finish before the API answers). In the background, at most once a minute, until it works.
   */
  private checkCredentialSoon(token: string): void {
    if (this.credentialChecked || this.credentialRunning) return;
    const now = Date.now();
    if (now - this.credentialAttemptAt < CREDENTIAL_RETRY_MS) return;
    this.credentialAttemptAt = now;
    this.credentialRunning = true;
    this.track(
      this.recordCredential(token).finally(() => {
        this.credentialRunning = false;
      }),
    );
  }

  private async recordCredential(token: string): Promise<void> {
    const { deployment, profile } = this.o;
    const id = await identifyCredential(deployment, token, this.o.log ?? silentLogger);
    if (id === null) return;
    try {
      const record = readProfileFor(profile, deployment.environment);
      if (record?.credentialId !== id) {
        await withLock(
          profile,
          (lock) => {
            const fresh = readProfileFor(profile, deployment.environment);
            if (fresh === null) {
              createProfile(profile, lock, { environment: deployment.environment, credentialId: id, agentLabel: "agent", createdAt: new Date().toISOString() });
            } else if (fresh.credentialId !== id) {
              updateProfile(profile, lock, (current) => ({ ...current, credentialId: id }));
            }
          },
          this.o.lockOptions,
        );
        this.log.info("credential recorded", { credential: id.slice(0, 8) });
      }
      this.credentialChecked = true;
    } catch (err) {
      this.log.warn("credential id not recorded; retried later", { error: errorName(err) });
    }
  }
}

function errorName(err: unknown): string {
  if (err instanceof LockError) return `LockError ${err.code}`;
  return err instanceof Error ? err.name : "error";
}

/** CARRY 2.7: LOCK_TIMEOUT → -32001; RefreshError → retry later; keychain → its own text. */
function tokenError(err: unknown, log: Logger): { code: number; message: string } {
  if (err instanceof LockError && err.code === "LOCK_TIMEOUT") return { code: LOCK_BUSY, message: MESSAGES.lockBusy };
  if (err instanceof RefreshError) return { code: UNREACHABLE, message: MESSAGES.unreachable("could not renew the sign-in; try again") };
  if (err instanceof KeychainError) return { code: SERVER_ERROR, message: err.message };
  log.warn("token unavailable", { error: errorName(err) });
  return { code: SERVER_ERROR, message: "Assay sign-in could not be read. Try again." };
}

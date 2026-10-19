import { randomUUID } from "node:crypto";
import { SIGN_IN_TOOL } from "../clients/server-name.js";
import { silentLogger, type Logger } from "../log/logger.js";
import { identifyAgent, SignInError, signInBusyError, type SignInResult } from "../oauth/flow.js";
import { currentAccess, hasGrant, RefreshError, refreshUnderLock, type TokenContext } from "../oauth/tokens.js";
import type { ResolvedDeployment } from "../profile/deployments.js";
import { KeychainError, type Keychain } from "../profile/keychain.js";
import { LockError, withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { createProfile, readProfileFor, updateProfile } from "../profile/profile.js";
import { AliasTable } from "./aliases.js";
import { CallRegistry, type ForwardedCall } from "./calls.js";
import { prepareCallParams, quotesFromList } from "./meta.js";
import type { PaidHost } from "./paid.js";
import { Forwarder, type FetchLike, type Outcome } from "./forwarder.js";
import { answerInitialize, answerSignedOut, appName, SignInController, signInBusyText, signInText, type SignInHooks } from "./presignin.js";
import {
  classify,
  envelopeVersion,
  errorResponse,
  INTERNAL_ERROR,
  idKey,
  INVALID_REQUEST,
  isModernVersion,
  isValidId,
  LOCK_BUSY,
  MESSAGES,
  NEWEST_LEGACY_VERSION,
  PARSE_ERROR,
  resultResponse,
  SERVER_ERROR,
  UNREACHABLE,
  type JsonRpcId,
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

/** The paid path (Task 2.9, `paid.ts`), as the proxy drives it. */
export interface PaidHooks {
  /** Sees each `tools/call` answer with its call record; returns what goes to the host. */
  onToolResult(call: ForwardedCall, response: JsonRpcResponse): Promise<JsonRpcResponse>;
  /** Quotes (`assay/price`) from a remote `tools/list` page, by original tool name. */
  observeList(pairs: ReturnType<typeof quotesFromList>): void;
  stop(): void;
}

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
  /** F1 (`oauth/flow.ts` `signIn` with the process's keychain and lock options; the hooks carry `passive`, `signal`, `onMarker`). */
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
  /** Builds the paid path on the proxy's services; none means every answer passes as is. */
  readonly paid?: (host: PaidHost) => PaidHooks;
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
  /** Whether the host declared form elicitation in `initialize` (G7 confirmation). */
  private hostElicits = false;
  /** Requests the proxy sent to the host (elicitation), by id, waiting for the host's answer. */
  private readonly hostRequests = new Map<string, (answer: unknown) => void>();
  private readonly paid: PaidHooks | null;

  constructor(private readonly o: ProxyOptions) {
    this.log = (o.log ?? silentLogger).child("proxy");
    this.forwarder = new Forwarder({
      url: o.deployment.url,
      fetch: o.fetch,
      log: o.log ?? silentLogger,
      ...(o.requestTimeoutMs !== undefined ? { timeoutMs: o.requestTimeoutMs } : {}),
    });
    this.aliases = new AliasTable(o.serverName, o.log ?? silentLogger);
    this.signIns = new SignInController((hooks) => this.runSignIn(hooks), (url) => o.openBrowser(url), signInBusyError);
    this.paid = o.paid ? o.paid(this.paidHost()) : null;
  }

  /** What the paid path may use: resend a call, ask `get_tool`, elicit, the API bearer. */
  private paidHost(): PaidHost {
    return {
      calls: this.calls,
      resend: (call, params) => this.sendToolCall(call.id, params),
      getTool: (name) => this.sendToolCall(`assay-mcp-get-tool-${randomUUID()}`, { name: "get_tool", arguments: { name } }),
      canElicit: () => this.hostElicits,
      elicit: (params, deadlineMs) => this.askHost("elicitation/create", params, deadlineMs),
      bearer: async () => {
        const b = await this.bearer();
        return "token" in b ? b.token : null;
      },
      dateOffset: () => this.forwarder.dateOffset(),
    };
  }

  /** One `tools/call` of the proxy's own (a paid retry or `get_tool`), through the same path. */
  private async sendToolCall(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method: "tools/call", params };
    const answer = await this.exchange(req, JSON.stringify(req));
    return answer === "signed-out" ? errorResponse(id, SERVER_ERROR, "Assay sign-in ended. Sign in again, then ask again.") : answer;
  }

  /**
   * Sends a request to the host and waits for its answer until `deadlineMs`: the result, a
   * `{action: "cancel"}` for an error answer, or `null` when none came in time.
   */
  private askHost(method: string, params: Record<string, unknown>, deadlineMs: number): Promise<unknown> {
    const id = `assay-mcp-${randomUUID()}`;
    const key = idKey(id);
    return new Promise((resolve) => {
      const done = (answer: unknown) => {
        clearTimeout(timer);
        this.hostRequests.delete(key);
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), Math.max(0, deadlineMs - Date.now()));
      timer.unref();
      this.hostRequests.set(key, done);
      if (!this.o.writer.send({ jsonrpc: "2.0", id, method, params })) done(null);
    });
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
    this.paid?.stop();
    for (const done of [...this.hostRequests.values()]) done(null);
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
      for (const item of parsed) {
        let raw: string;
        try {
          raw = JSON.stringify(item);
        } catch {
          // Nested deeper than JSON.stringify can go: refused, never a crash (review M2).
          const id = typeof item === "object" && item !== null && isValidId((item as { id?: unknown }).id) ? (item as { id: JsonRpcId }).id : null;
          this.o.writer.send(errorResponse(id, INVALID_REQUEST, "Invalid Request"));
          continue;
        }
        this.handleMessage(item, raw);
      }
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
      case "response": {
        // An answer to a request the proxy itself sent (elicitation); any other is dropped (§7.6).
        const id = c.message.id;
        const waiting = id === null ? undefined : this.hostRequests.get(idKey(id));
        if (waiting) waiting("result" in c.message ? c.message.result : { action: "cancel" });
        return;
      }
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
            .then((response) => {
              // An answer that cannot be serialised still gets an answer (review M1).
              if (!this.o.writer.send(response)) this.o.writer.send(errorResponse(req.id, SERVER_ERROR, "Assay's answer could not be passed on."));
            }),
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
    if (n.method === "notifications/cancelled" && isValidId(n.params?.requestId)) this.calls.cancel(n.params.requestId);
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
      this.hostElicits = declaresFormElicitation(req.params?.capabilities);
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
      const tool = typeof req.params?.name === "string" ? req.params.name : "";
      if (err instanceof SignInError && err.reason === "busy") {
        return resultResponse(req.id, { content: [{ type: "text", text: signInBusyText(this.app) }], ...(tool === SIGN_IN_TOOL ? {} : { isError: true }) });
      }
      if (this.mode === "signed-in") return this.forward(req, JSON.stringify(req)); // a grant was already stored
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
    if (result.existing) {
      // A grant was stored before or meanwhile (another window): use it.
      this.credentialChecked = false;
      this.enterSignedIn();
      return;
    }
    this.credentialChecked = result.credentialId !== null;
    this.credentialAttemptAt = 0;
    this.enterSignedIn();
  }

  /** A signed-out process picks up a grant another process (or `login`) stored. */
  private async lookForGrant(): Promise<void> {
    if (this.o.apiKey !== null || this.mode !== "pre-sign-in") return;
    let refresh: string | null;
    try {
      refresh = await this.o.keychain.get("refresh_token");
    } catch {
      return;
    }
    if (refresh !== null && refresh !== this.rejectedRefresh) {
      this.signIns.cancel(); // another process signed in: stop waiting for our own browser
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
      // §7.7 step 1: a host voucher or rail is dropped, the idempotency key kept or added.
      // A call on an alias goes out with the exact original name.
      const prepared = prepareCallParams(original !== null && original !== name ? { ...(req.params ?? {}), name: original } : (req.params ?? {}));
      body = JSON.stringify({ ...req, params: prepared });
      call = this.calls.begin(req.id, original ?? "", prepared);
      if (call === null) return errorResponse(req.id, INVALID_REQUEST, "A request with this id is already in flight.");
    }
    try {
      const response = await this.exchange(req, body);
      if (response === "signed-out") return this.answerSignedOut(req);
      return call !== null && this.paid ? await this.paid.onToolResult(call, response) : response;
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
      // G3 quotes by the remote's own names, before any alias is applied.
      this.paid?.observeList(quotesFromList(response.result));
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
    const identity = await identifyAgent(deployment, token, this.o.log ?? silentLogger);
    if (identity === null) return;
    const { credentialId: id, agentLabel } = identity;
    const stale = (r: { credentialId: string; agentLabel: string } | null) => r?.credentialId !== id || (agentLabel !== null && r.agentLabel !== agentLabel);
    try {
      const record = readProfileFor(profile, deployment.environment);
      if (stale(record)) {
        await withLock(
          profile,
          (lock) => {
            const fresh = readProfileFor(profile, deployment.environment);
            if (fresh === null) {
              createProfile(profile, lock, { environment: deployment.environment, credentialId: id, agentLabel: agentLabel ?? "agent", createdAt: new Date().toISOString() });
            } else if (stale(fresh)) {
              updateProfile(profile, lock, (current) => ({ ...current, credentialId: id, ...(agentLabel !== null ? { agentLabel } : {}) }));
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

/** The host declared form elicitation: `capabilities.elicitation` is `{}` or names `form`. */
export function declaresFormElicitation(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const e = (capabilities as Record<string, unknown>).elicitation;
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  const keys = Object.keys(e);
  return keys.length === 0 || keys.includes("form");
}

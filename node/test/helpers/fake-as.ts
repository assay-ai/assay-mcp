import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A local fake of the Assay authorization server (backend `src/modules/oauth`), for tests only.
 *
 * It models what the proxy depends on: the built-in client id, the loopback redirect (any
 * port), PKCE S256, `resource`, `iss` on every authorization response, refresh rotation with
 * the 30 s grace (same pair) and reuse detection (a rotated token presented after 30 s, once a
 * descendant was used, revokes the whole grant), revoke (RFC 7009, always 200), and
 * `GET /api/v1/agents/me/delegate` in the API envelope. It listens on 127.0.0.1 only; tests
 * reroute the e2e origins (`localhost:3200`, `localhost:3000`) to it.
 */

export const E2E_MCP = "http://localhost:3200";
export const E2E_API_ORIGIN = "http://localhost:3000";
export const CLIENT_ID = `${E2E_MCP}/oauth/clients/assay-mcp`;
export const GRACE_SECONDS = 30;

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly form: URLSearchParams | null;
  readonly authorization: string | undefined;
}

interface Grant {
  credentialId: string;
  revoked: boolean;
}
interface RefreshRow {
  grant: Grant;
  usedAt: number | null;
  child: { refresh: string; access: string } | null;
  grace: Record<string, unknown> | null;
}
interface AccessRow {
  grant: Grant;
  expiresAt: number;
  firstUsedAt: number | null;
}
interface CodeRow {
  challenge: string;
  redirectUri: string;
  used: boolean;
  credentialId: string;
}

const b64 = () => randomBytes(32).toString("base64url");

export class FakeAs {
  port = 0;
  /** Seconds; tests move it. */
  clock = 1_800_000_000;
  /** Delay before each `/oauth/token` answer (widens races). */
  tokenDelayMs = 0;
  /** When set, `/oauth/token` waits for it before answering. */
  tokenGate: Promise<void> | null = null;
  /** Forces this status and error on `/oauth/token`. */
  forceTokenError: { status: number; error: string } | null = null;
  /** Per path: answer badly (never, one byte at a time, reset after the headers, too long). */
  misbehave: Partial<Record<string, "stall" | "drip" | "reset" | "huge">> = {};
  /** Overrides `expires_in` on issued pairs. */
  expiresIn: number | null = null;
  /** The `agentLabel` `GET /agents/me/delegate` answers with (the owner's name for the agent). */
  agentLabel: unknown = "research-bot";
  readonly requests: SeenRequest[] = [];
  readonly authorizeParams: URLSearchParams[] = [];
  readonly grants: Grant[] = [];
  private readonly codes = new Map<string, CodeRow>();
  private readonly refresh = new Map<string, RefreshRow>();
  private readonly access = new Map<string, AccessRow>();
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((r) => this.server!.close(r));
  }

  tokenCalls(grantType?: string): SeenRequest[] {
    return this.requests.filter((r) => r.path === "/oauth/token" && (grantType === undefined || r.form?.get("grant_type") === grantType));
  }

  /** Seeds a live grant and returns its pair (as a prior sign-in would have stored it). */
  seedGrant(expiresIn = 3600): { refreshToken: string; accessToken: string; expiresAt: number; credentialId: string } {
    const grant: Grant = { credentialId: randomUUID(), revoked: false };
    this.grants.push(grant);
    const pair = this.issue(grant, expiresIn);
    return { refreshToken: pair.refresh_token, accessToken: pair.access_token, expiresAt: this.clock + expiresIn, credentialId: grant.credentialId };
  }

  /**
   * The consent step: validates the authorize URL like the server and returns the URL the
   * browser is redirected to (`redirect_uri?code&state&iss`), or the error redirect.
   */
  approve(authorizeUrl: string, decision: "approve" | "deny" = "approve"): string {
    const url = new URL(authorizeUrl);
    const q = url.searchParams;
    this.authorizeParams.push(q);
    if (url.origin !== E2E_MCP || url.pathname !== "/oauth/authorize") throw new Error("not the authorize endpoint");
    if (q.get("client_id") !== CLIENT_ID) throw new Error("client_unknown");
    const redirect = q.get("redirect_uri") ?? "";
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/callback$/.test(redirect)) throw new Error("redirect_uri_mismatch");
    const back = new URL(redirect);
    if (q.get("state")) back.searchParams.set("state", q.get("state")!);
    back.searchParams.set("iss", E2E_MCP);
    const ok =
      q.get("response_type") === "code" &&
      /^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "") &&
      q.get("code_challenge_method") === "S256" &&
      (q.get("resource") === null || q.get("resource") === E2E_MCP);
    if (!ok || decision === "deny") {
      back.searchParams.set("error", ok ? "access_denied" : "invalid_request");
      return back.href;
    }
    const code = `assay_ac_${b64()}`;
    this.codes.set(code, { challenge: q.get("code_challenge")!, redirectUri: redirect, used: false, credentialId: randomUUID() });
    back.searchParams.set("code", code);
    return back.href;
  }

  /** Marks an access token as used (a resource request), as the session source would. */
  use(accessToken: string): boolean {
    const row = this.access.get(accessToken);
    if (!row || row.grant.revoked || row.expiresAt <= this.clock) return false;
    row.firstUsedAt ??= this.clock;
    return true;
  }

  private issue(grant: Grant, requested = 3600) {
    const expiresIn = this.expiresIn ?? requested;
    const refresh = `assay_rt_${b64()}`;
    const access = `assay_at_${b64()}`;
    this.refresh.set(refresh, { grant, usedAt: null, child: null, grace: null });
    this.access.set(access, { grant, expiresAt: this.clock + expiresIn, firstUsedAt: null });
    return { access_token: access, token_type: "Bearer", expires_in: expiresIn, refresh_token: refresh, scope: "assay:agent offline_access" };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const form = req.headers["content-type"] === "application/x-www-form-urlencoded" ? new URLSearchParams(raw) : null;
    this.requests.push({ method: req.method ?? "", path: url.pathname, form, authorization: req.headers.authorization });
    const mode = this.misbehave[url.pathname];
    if (mode === "stall") return; // never answers; the socket stays open
    if (mode === "drip") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write(" ")), 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (mode === "reset") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"access_token":"');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    if (mode === "huge") {
      // A valid answer (a real pair on the token endpoint), padded past 64 KiB: only the body
      // cap can refuse it.
      const [status, body] = url.pathname === "/oauth/token" && form ? this.token(form) : [200, {}];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ...(body as object), pad: "a".repeat(100_000) }));
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      if (this.tokenGate) await this.tokenGate;
      if (this.forceTokenError) return json(this.forceTokenError.status, { error: this.forceTokenError.error });
      if (!form) return json(400, { error: "invalid_request" });
      const [status, body] = this.token(form);
      return json(status, body);
    }
    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      const token = form?.get("token") ?? "";
      if (form?.get("client_id") === CLIENT_ID) {
        const row = this.refresh.get(token);
        if (row) row.grant.revoked = true;
      }
      res.writeHead(200, { "cache-control": "no-store" }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/agents/me/delegate") {
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (!this.use(bearer)) return json(401, { statusCode: 401, message: "MCP_CREDENTIAL_INVALID" });
      const row = this.access.get(bearer)!;
      return json(200, { data: { credentialId: row.grant.credentialId, agentLabel: this.agentLabel, delegate: null, boundAt: null }, statusCode: 200, message: "Success" });
    }
    json(404, { error: "not_found" });
  }

  private token(form: URLSearchParams): [number, unknown] {
    const invalidGrant: [number, unknown] = [400, { error: "invalid_grant" }];
    if (form.get("client_id") !== CLIENT_ID) return [400, { error: "invalid_request" }];
    const type = form.get("grant_type");
    if (type === "authorization_code") {
      const row = this.codes.get(form.get("code") ?? "");
      if (!row || row.used) return invalidGrant;
      row.used = true;
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) || challenge !== row.challenge) return invalidGrant;
      if (form.get("redirect_uri") !== row.redirectUri) return invalidGrant;
      if (form.get("resource") !== null && form.get("resource") !== E2E_MCP) return [400, { error: "invalid_target" }];
      const grant: Grant = { credentialId: row.credentialId, revoked: false };
      this.grants.push(grant);
      return [200, this.issue(grant)];
    }
    if (type === "refresh_token") {
      const row = this.refresh.get(form.get("refresh_token") ?? "");
      if (!row || row.grant.revoked) return invalidGrant;
      if (row.usedAt === null) {
        row.usedAt = this.clock;
        const pair = this.issue(row.grant);
        row.child = { refresh: pair.refresh_token, access: pair.access_token };
        row.grace = pair;
        return [200, pair];
      }
      if (this.clock - row.usedAt <= GRACE_SECONDS) return row.grace ? [200, row.grace] : invalidGrant;
      const child = row.child!;
      const descendantUsed = this.refresh.get(child.refresh)!.usedAt !== null || this.access.get(child.access)!.firstUsedAt !== null;
      if (descendantUsed) row.grant.revoked = true;
      return invalidGrant;
    }
    return [400, { error: "unsupported_grant_type" }];
  }
}

/**
 * Reroutes the e2e origins to the fake AS (transport only: `pinnedFetch` checks the real URL
 * first). Every other URL (the loopback callback) goes to the real fetch.
 */
export function rerouteFetch(realFetch: typeof fetch, port: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
    if (u.origin === E2E_MCP || u.origin === E2E_API_ORIGIN) return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    return realFetch(input, init);
  }) as typeof fetch;
}

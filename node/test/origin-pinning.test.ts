import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInDeployments, type Deployment } from "../src/deployments.js";
import { carriesBearer, pinnedFetch, PinnedFetchError, targetOf, USER_AGENT } from "../src/net/fetch.js";
import {
  apiKeyFromEnv,
  assertSignerEnvironment,
  isResolvedDeployment,
  isTrustedDeployment,
  OriginError,
  resolveDeployment,
  type ResolvedDeployment,
} from "../src/profile/deployments.js";
import { addDevOrigin, devOriginsFromEnv, normaliseOrigin, readDevOrigins } from "../src/profile/dev-origins.js";
import { VERSION } from "../src/version.js";

const DEV = "http://localhost:3200";
const table = builtInDeployments();
const PROD_MCP = table.production.mcp;

let dir: string;
let warnings: string[];
const warn = (line: string) => void warnings.push(line);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "assay-mcp-origin-"));
  warnings = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveDeployment", () => {
  it("defaults to the production MCP root", () => {
    const d = resolveDeployment({ env: {}, devOrigins: [], warn });
    expect(d.environment).toBe("production");
    expect(d.dev).toBe(false);
    expect(d.url).toBe(`${PROD_MCP}/`);
    expect(d.mcp).toBe(PROD_MCP);
    expect(d.issuer).toBe(table.production.issuer);
    expect(warnings).toEqual([]);
  });

  it("canonicalises --url like the server", () => {
    const r = (url: string) => resolveDeployment({ url, env: {}, devOrigins: [], warn }).url;
    expect(r("/C/Weather/")).toBe(`${PROD_MCP}/c/weather`);
    expect(r(`${PROD_MCP}/%40Acme/Kit@3?free=1&tools=beta,alpha,Alpha`)).toBe(`${PROD_MCP}/@acme/kit@3?tools=alpha,beta&free=1`);
    expect(r(`${PROD_MCP}/?discovery=search`)).toBe(`${PROD_MCP}/`);
    expect(r("https://MCP.assay.ai:443/c/weather#frag")).toBe(`${PROD_MCP}/c/weather`);
    for (const bad of ["/t/x", "/c/weather/../x", "/?free=true", "/c/%2e%2e", "not a url"]) {
      expect(() => resolveDeployment({ url: bad, env: {}, devOrigins: [], warn })).toThrow(OriginError);
    }
  });

  it("--url https://evil.example/ refused", () => {
    for (const url of [
      "https://evil.example/",
      "//evil.example/",
      "http://mcp.assay.ai/",
      "https://mcp.assay.ai.evil.example/",
      "https://mcp.assay.ai@evil.example/",
      "https://user:pass@mcp.assay.ai/",
      "https://mcp.assay.ai:8443/",
    ]) {
      expect(() => resolveDeployment({ url, env: {}, devOrigins: [], warn }), url).toThrow(OriginError);
    }
  });

  it("an evil origin is refused even when listed in both dev lists", () => {
    const env = { ASSAY_MCP_DEV_ORIGINS: "https://evil.example" };
    expect(() => resolveDeployment({ url: "https://evil.example/", env, devOrigins: ["https://evil.example"], warn })).toThrow(
      /no built-in dev deployment/,
    );
  });

  it("dev env only → refused", () => {
    const env = { ASSAY_MCP_DEV_ORIGINS: DEV };
    expect(() => resolveDeployment({ url: `${DEV}/`, env, devOrigins: [], warn })).toThrow(OriginError);
    expect(warnings).toEqual([]);
  });

  it("dev file only → refused", () => {
    addDevOrigin(dir, DEV);
    expect(() => resolveDeployment({ url: `${DEV}/`, env: {}, devOrigins: readDevOrigins(dir), warn })).toThrow(OriginError);
    expect(warnings).toEqual([]);
  });

  it("both → e2e deployment + warning on stderr", () => {
    addDevOrigin(dir, `${DEV}/`);
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const d = resolveDeployment({
      url: `${DEV}/c/weather`,
      env: { ASSAY_MCP_DEV_ORIGINS: ` https://other.example , ${DEV} ` },
      devOrigins: readDevOrigins(dir),
    });
    expect(d.environment).toBe("e2e");
    expect(d.dev).toBe(true);
    expect(d.url).toBe(`${DEV}/c/weather`);
    expect(d.api).toBe(table.e2e.api);
    expect(d.issuer).toBe(table.e2e.issuer);
    expect(stdout).not.toHaveBeenCalled();
    const text = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("dev mode (e2e)");
    expect(text).toContain("Do not use it with real funds");
  });

  it("the production origin in the dev lists is still production, without a warning", () => {
    const d = resolveDeployment({ url: `${PROD_MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: PROD_MCP }, devOrigins: [PROD_MCP], warn });
    expect(d.environment).toBe("production");
    expect(d.dev).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("ASSAY_API_KEY ignored in dev mode, ASSAY_DEV_API_KEY read", () => {
    const env = { ASSAY_MCP_DEV_ORIGINS: DEV, ASSAY_API_KEY: "assay_sk_live_realKeyValue", ASSAY_DEV_API_KEY: "assay_sk_live_devKeyValue" };
    const dev = resolveDeployment({ url: `${DEV}/`, env, devOrigins: [DEV], warn });
    expect(apiKeyFromEnv(dev, env)).toBe("assay_sk_live_devKeyValue");
    expect(apiKeyFromEnv(dev, { ASSAY_API_KEY: "assay_sk_live_realKeyValue" })).toBeNull();
    const prod = resolveDeployment({ env, devOrigins: [], warn });
    expect(apiKeyFromEnv(prod, env)).toBe("assay_sk_live_realKeyValue");
    expect(apiKeyFromEnv(prod, { ASSAY_DEV_API_KEY: "assay_sk_live_devKeyValue" })).toBeNull();
    expect(apiKeyFromEnv(prod, { ASSAY_API_KEY: "   " })).toBeNull();
  });

  it('editing profiles/default.json to add "mcp":"https://evil" has no effect', () => {
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(
      join(dir, "profiles", "default.json"),
      JSON.stringify({ version: 1, environment: "e2e", mcp: "https://evil", api: "https://evil/api", issuer: "https://evil", rpc: ["https://evil"] }),
    );
    const d = resolveDeployment({ env: {}, devOrigins: readDevOrigins(dir), warn });
    expect(d.environment).toBe("production");
    expect(d.mcp).toBe(PROD_MCP);
    expect(JSON.stringify(d)).not.toContain("evil");
  });

  it("returns a frozen copy: the built-in table cannot be changed through it", () => {
    const d = resolveDeployment({ env: {}, devOrigins: [], warn });
    expect(() => {
      (d as { mcp: string }).mcp = "https://evil.example";
    }).toThrow();
    expect(table.production.mcp).toBe(PROD_MCP);
  });
});

describe("only production reaches the signer outside dev mode", () => {
  const urls = [undefined, "/", "/c/weather", `${PROD_MCP}/@acme/kit`, `${DEV}/`, "http://127.0.0.1:3200/", "https://evil.example/"];
  // Every combination of the two dev inputs short of "both name the origin".
  const partial: { env: Record<string, string>; devOrigins: string[] }[] = [
    { env: {}, devOrigins: [] },
    { env: { ASSAY_MCP_DEV_ORIGINS: DEV }, devOrigins: [] },
    { env: {}, devOrigins: [DEV] },
    { env: { ASSAY_MCP_DEV_ORIGINS: "http://localhost:3201" }, devOrigins: [DEV] },
  ];

  it("without both dev inputs every --url resolves to production or is refused", () => {
    for (const url of urls) {
      for (const inputs of partial) {
        let d;
        try {
          d = resolveDeployment({ url, ...inputs, warn });
        } catch (err) {
          expect(err).toBeInstanceOf(OriginError);
          continue;
        }
        expect(d.environment).toBe("production");
        expect(d.dev).toBe(false);
        expect(() => assertSignerEnvironment(d)).not.toThrow();
      }
    }
    expect(warnings).toEqual([]);
  });

  it("dev mode is only ever the result of both local inputs, and is explicit", () => {
    const d = resolveDeployment({ url: `${DEV}/`, env: { ASSAY_MCP_DEV_ORIGINS: DEV }, devOrigins: [DEV], warn });
    expect(d).toMatchObject({ environment: "e2e", dev: true });
    expect(() => assertSignerEnvironment(d)).not.toThrow();
    expect(Object.isFrozen(d)).toBe(true);
  });

  it("the signer gate accepts only resolveDeployment results, never a look-alike object", () => {
    const prod = resolveDeployment({ env: {}, devOrigins: [], warn });
    expect(() => assertSignerEnvironment(prod)).not.toThrow();
    const lookAlikes = [
      { ...prod },
      structuredClone(prod),
      { ...table.e2e, environment: "e2e", dev: true, url: `${DEV}/` },
      { ...table.production, environment: "production", dev: false, url: `${PROD_MCP}/` },
      { environment: "anvil", dev: true },
    ];
    for (const fake of lookAlikes) {
      expect(() => assertSignerEnvironment(fake as unknown as ResolvedDeployment)).toThrow(OriginError);
      expect(isResolvedDeployment(fake)).toBe(false);
    }
  });

  it("does not mutate the built-in table", () => {
    const before = JSON.stringify(builtInDeployments());
    resolveDeployment({ url: `${DEV}/`, env: { ASSAY_MCP_DEV_ORIGINS: DEV }, devOrigins: [DEV], warn });
    resolveDeployment({ env: {}, devOrigins: [], warn });
    expect(JSON.stringify(builtInDeployments())).toBe(before);
  });
});

describe("dev-origins.json", () => {
  it("normalises origins and refuses anything that is not a bare origin", () => {
    expect(normaliseOrigin("http://LOCALHOST:3200/")).toBe(DEV);
    for (const bad of ["http://localhost:3200/x", "http://u@localhost:3200", "ftp://localhost", "http://localhost:3200/?a", "localhost:3200"]) {
      expect(normaliseOrigin(bad), bad).toBeNull();
    }
    expect(devOriginsFromEnv({ ASSAY_MCP_DEV_ORIGINS: "junk, http://localhost:3200/ ,http://localhost:3200" })).toEqual([DEV]);
  });

  it("is written 0600 and read back", () => {
    addDevOrigin(dir, DEV);
    addDevOrigin(dir, DEV);
    expect(readDevOrigins(dir)).toEqual([DEV]);
  });

  it("a symlinked or malformed file reads as empty", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify({ version: 1, origins: [DEV] }));
    symlinkSync(real, join(dir, "dev-origins.json"));
    expect(readDevOrigins(dir)).toEqual([]);
    rmSync(join(dir, "dev-origins.json"));
    writeFileSync(join(dir, "dev-origins.json"), "{not json", { mode: 0o600 });
    expect(readDevOrigins(dir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a 0644 dev-origins.json (e.g. committed to a repo) reads as empty", () => {
    writeFileSync(join(dir, "dev-origins.json"), JSON.stringify({ version: 1, origins: [DEV] }), { mode: 0o644 });
    expect(readDevOrigins(dir)).toEqual([]);
    expect(() =>
      resolveDeployment({ url: `${DEV}/`, env: { ASSAY_MCP_DEV_ORIGINS: DEV }, devOrigins: readDevOrigins(dir), warn }),
    ).toThrow(OriginError);
  });
});

describe("pinnedFetch", () => {
  const prod = table.production;
  const e2eRaw = table.e2e;
  const e2e = () => resolveDeployment({ url: `${DEV}/`, env: { ASSAY_MCP_DEV_ORIGINS: DEV }, devOrigins: [DEV], warn });
  const rpcUrl = e2eRaw.networks["eip155:46630"]!.rpc[0]!;

  function spyFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
  }
  function sent(spy: ReturnType<typeof spyFetch>, i: number): RequestInit {
    return spy.mock.calls[i]![1]!;
  }

  it("attaches Authorization only for mcp and api, and the User-Agent always", async () => {
    const spy = spyFetch();
    const d = e2e();
    await pinnedFetch(d, `${d.mcp}/`, { method: "POST", bearer: "tok" });
    await pinnedFetch(d, `${d.api}/agents/me`, { bearer: "tok" });
    // The e2e issuer is the MCP origin, so it is the MCP target.
    await pinnedFetch(d, d.issuer, { bearer: "tok" });
    expect(spy).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const h = new Headers(sent(spy, i).headers);
      expect(h.get("authorization")).toBe("Bearer tok");
      expect(h.get("user-agent")).toBe(USER_AGENT);
    }
    expect(USER_AGENT).toBe(`assay-mcp/${VERSION}`);
  });

  it("a distinct issuer origin is its own target and never gets the bearer", () => {
    const forged = { ...e2eRaw, issuer: "https://issuer.example" } as Deployment;
    expect(targetOf(forged, new URL("https://issuer.example/oauth/token"))).toBe("issuer");
    expect(targetOf(forged, new URL(`${e2eRaw.mcp}/`))).toBe("mcp");
    expect(carriesBearer("issuer")).toBe(false);
    expect(carriesBearer("rpc")).toBe(false);
    expect(carriesBearer("mcp")).toBe(true);
    expect(carriesBearer("api")).toBe(true);
  });

  it("pinnedFetch to rpc never carries Authorization", async () => {
    const spy = spyFetch();
    const d = e2e();
    await pinnedFetch(d, rpcUrl, { method: "POST", bearer: "tok", body: "{}" });
    const h = new Headers(sent(spy, 0).headers);
    expect(h.has("authorization")).toBe(false);
    expect(h.get("user-agent")).toBe(USER_AGENT);
    await expect(pinnedFetch(d, rpcUrl, { headers: { Authorization: "Bearer tok" } })).rejects.toThrow(PinnedFetchError);
    await expect(pinnedFetch(d, rpcUrl, { headers: [["authorization", "x"]] })).rejects.toThrow(PinnedFetchError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses every other origin before any request", async () => {
    const spy = spyFetch();
    const d = e2e();
    for (const url of [
      "https://evil.example/",
      prod.web, // a placeholder in production: not a URL
      e2eRaw.web, // {WEB} is opened in a browser, never fetched
      "http://localhost:3201/",
      "http://u:p@localhost:3200/",
    ]) {
      await expect(pinnedFetch(d, url, { bearer: "tok" }), url).rejects.toThrow(PinnedFetchError);
    }
    // Another environment's hosts are not this deployment's.
    await expect(pinnedFetch(prod, `${e2eRaw.mcp}/`)).rejects.toThrow(PinnedFetchError);
    await expect(pinnedFetch(prod, rpcUrl)).rejects.toThrow(PinnedFetchError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts only a resolveDeployment result or the built-in production entry", async () => {
    const spy = spyFetch();
    const forged: Deployment = { ...e2eRaw, api: "https://evil.example" };
    const fakes: Deployment[] = [forged, e2eRaw, structuredClone(prod), { ...prod }, { ...e2e() }];
    for (const fake of fakes) {
      expect(isTrustedDeployment(fake)).toBe(false);
      await expect(pinnedFetch(fake, `${fake.mcp}/`, { bearer: "tok" })).rejects.toThrow(/not a built-in entry/);
    }
    expect(isTrustedDeployment(prod)).toBe(true);
    expect(isTrustedDeployment(e2e())).toBe(true);
    expect(isTrustedDeployment(resolveDeployment({ env: {}, devOrigins: [], warn }))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("redirect: 'error' on every call", async () => {
    const spy = spyFetch();
    const d = e2e();
    const calls: [string, Parameters<typeof pinnedFetch>[2]][] = [
      [`${d.mcp}/`, { method: "POST", bearer: "tok" }],
      [`${d.mcp}/`, { redirect: "follow" } as unknown as Parameters<typeof pinnedFetch>[2]],
      [`${d.api}/x`, { redirect: "manual" } as unknown as Parameters<typeof pinnedFetch>[2]],
      [rpcUrl, { method: "POST", body: "{}" }],
      [`${d.issuer}/oauth/token`, {}],
      [`${d.mcp}/`, undefined],
    ];
    for (const [url, init] of calls) await pinnedFetch(d, url, init);
    expect(spy).toHaveBeenCalledTimes(calls.length);
    for (let i = 0; i < calls.length; i++) expect(sent(spy, i).redirect).toBe("error");
  });

  it("a real 302 to a live endpoint is refused, not followed", async () => {
    const { createServer } = await import("node:http");
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/elsewhere") res.writeHead(200, { "content-type": "application/json" }).end("{}");
      else res.writeHead(302, { location: "/elsewhere" }).end();
    });
    // An ephemeral port: never skipped because a fixed port is busy.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const realFetch = globalThis.fetch;
    // Only the transport is rerouted to the local server; pinnedFetch's checks and the
    // RequestInit it builds go to the real fetch unchanged.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const u = new URL(String(input instanceof URL ? input.href : input));
      return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    });
    try {
      // Sanity: the target answers 200, so following the redirect would succeed.
      const direct = await realFetch(`http://127.0.0.1:${port}/elsewhere`);
      expect(direct.status).toBe(200);
      hits.length = 0;

      const d = e2e();
      const err = await pinnedFetch(d, `${d.mcp}/`, { method: "POST", body: "{}", bearer: "tok" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TypeError);
      expect(String((err as { cause?: unknown }).cause)).toMatch(/redirect/i);
      expect(hits).toEqual(["/"]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

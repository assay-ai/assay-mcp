import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signIn } from "../src/oauth/flow.js";
import { currentAccess, refreshUnderLock, revoke } from "../src/oauth/tokens.js";
import { resolveDeployment } from "../src/profile/deployments.js";
import { Keychain } from "../src/profile/keychain.js";
import { MemoryKeyring } from "./helpers/memory-keyring.js";

/*
 * F1, F2 and revoke against the real Part 1 backend (the local e2e stack), gated so the
 * default run makes no network request. CI (and a person) runs it with the stack up:
 *   ASSAY_MCP_E2E=1 ASSAY_MCP_E2E_HUMAN_TOKEN=<config buyer token> npm test -w node -- oauth-e2e
 * The consent step uses the stack's config buyer session (brief §0 item 8), standing in for
 * the person in the browser: it reads the request, approves it for the first active agent,
 * and finishes `continue` with the request cookie, exactly as the consent page would.
 */
const enabled = process.env.ASSAY_MCP_E2E === "1";
const humanToken = process.env.ASSAY_MCP_E2E_HUMAN_TOKEN ?? "";
const MCP = "http://localhost:3200";

describe.runIf(enabled)("OAuth against the Part 1 backend (e2e stack)", () => {
  it("signs in, refreshes (rotation) and revokes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-mcp-oauth-e2e-"));
    try {
      const deployment = resolveDeployment({ url: `${MCP}/`, env: { ASSAY_MCP_DEV_ORIGINS: MCP }, devOrigins: [MCP], warn: () => {} });
      const keychain = new Keychain(new MemoryKeyring(), { profile: "default", environment: deployment.environment });
      const profile = { dir, name: "default" };

      const consent = async (authorizeUrl: string): Promise<boolean> => {
        const start = await fetch(authorizeUrl, { redirect: "manual" });
        const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
        const rid = new URL(start.headers.get("location")!).hash.replace(/^#request=/, "");
        const auth = { authorization: `Bearer ${humanToken}`, "content-type": "application/json" };
        const read = (await (await fetch(`${deployment.api}/oauth/requests/${rid}`, { headers: auth })).json()) as { data: { agents: { id: string; active: boolean }[] } };
        const agent = read.data.agents.find((a) => a.active)!;
        const approved = (await (await fetch(`${deployment.api}/oauth/requests/${rid}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ agentId: agent.id, name: "assay-mcp e2e" }) })).json()) as {
          data: { redirectTo: string };
        };
        const cont = await fetch(approved.data.redirectTo, { redirect: "manual", headers: { cookie } });
        await fetch(cont.headers.get("location")!);
        return true;
      };

      const { credentialId } = await signIn(profile, deployment, { device: "ci" }, { keychain, openBrowser: consent });
      expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
      const first = await currentAccess({ profile, deployment, keychain });
      expect(first).toMatch(/^assay_at_/);
      const second = await refreshUnderLock({ profile, deployment, keychain }, first);
      expect(second).toMatch(/^assay_at_/);
      expect(second).not.toBe(first);
      expect(await revoke({ profile, deployment, keychain })).toEqual({ revoked: true });
      expect(await currentAccess({ profile, deployment, keychain })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

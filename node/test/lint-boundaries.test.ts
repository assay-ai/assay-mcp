import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function restricted(filePath: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${filePath}` });
  return (result?.messages ?? []).some((m) => m.ruleId === "no-restricted-imports");
}

describe("signer internals stay inside src/signer", () => {
  it.each([
    'import { resolveNetworkFrom } from "./signer/network.internal.js";\nexport { resolveNetworkFrom };\n',
    'import { buildVoucherFor } from "../signer/voucher.internal.js";\nexport { buildVoucherFor };\n',
    'import type { ResolvedNetwork } from "./signer/network.internal";\nexport type { ResolvedNetwork };\n',
  ])("refuses an import from outside: %s", async (code) => {
    expect(await restricted("node/src/lint-fixture.ts", code)).toBe(true);
    expect(await restricted("node/src/commands/lint-fixture.ts", code)).toBe(true);
  });

  it("allows it inside src/signer, and allows the public modules everywhere", async () => {
    expect(
      await restricted(
        "node/src/signer/lint-fixture.ts",
        'import { resolveNetworkFrom } from "./network.internal.js";\nexport { resolveNetworkFrom };\n',
      ),
    ).toBe(false);
    expect(
      await restricted(
        "node/src/lint-fixture.ts",
        'import { buildVoucher } from "./signer/voucher.js";\nexport { buildVoucher };\n',
      ),
    ).toBe(false);
  });
});

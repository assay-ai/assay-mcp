// Prints the SQL the `integration` CI job seeds the backend's database with, after its
// migrations: one organization and one agent for every demo token of the backend's own seed
// (`scripts/mcp/seed/credentials.json`, same ids), and an opened escrow record for the human
// session's organization, which makes it "verified" so it may claim a handle (the `/@{h}` and
// shared tool set URL kinds). Test data only; idempotent.
//   node seed-sql.mjs <credentials.json> <human token> | psql …
import { readFileSync } from "node:fs";

const [file, humanToken] = process.argv.slice(2);
if (!file || !humanToken) {
  console.error("usage: node seed-sql.mjs <credentials.json> <human token>");
  process.exit(2);
}
const creds = JSON.parse(readFileSync(file, "utf8"));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = [];
for (const c of Object.values(creds)) {
  lines.push(`INSERT INTO organizations (id, name, created_via) VALUES (${q(c.organizationId)}, ${q(`ci org ${c.organizationId.slice(0, 8)}`)}, 'PRIVY_SIGNUP') ON CONFLICT DO NOTHING;`);
}
for (const c of Object.values(creds)) {
  lines.push(
    `INSERT INTO agents (id, organization_id, privy_user_id, label, primary_account_id, chain_id) VALUES (${q(c.agentId)}, ${q(c.organizationId)}, ${q(`ci:${c.credentialId}`)}, ${q(String(c.label).slice(0, 128))}, ${q(c.agentAccount)}, ${q(c.chainId)}) ON CONFLICT DO NOTHING;`,
  );
}
const human = creds[humanToken];
if (!human) {
  console.error("the human token is not in the credentials file");
  process.exit(2);
}
// A placeholder escrow record (no chain involved): only `opened_at` is read, by the handle check.
const escrow = `${human.chainId}:ci-placeholder-escrow`;
lines.push(
  `INSERT INTO buyer_escrows (organization_id, account_id, asset_id, escrow_account_id, escrow_asset_account_id, opened_at) VALUES (${q(human.organizationId)}, ${q(human.agentAccount)}, ${q(`${human.chainId}/ci-placeholder-asset`)}, ${q(escrow)}, ${q(escrow)}, now()) ON CONFLICT DO NOTHING;`,
);
process.stdout.write(`${lines.join("\n")}\n`);

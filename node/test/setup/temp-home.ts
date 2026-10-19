/**
 * Per test file (review I2): `os.userInfo().homedir` is a fresh temporary directory, so
 * `configDir()` and every default dependency built from it (`defaultDeps`, `defaultProfileDeps`,
 * the real CLI entry) use a temporary `{dir}`, never the real profile directory. Child
 * processes get their profile directory passed explicitly.
 */
import { afterAll, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  state.home = mkdtempSync(join(real.tmpdir(), "assay-mcp-home-"));
  const userInfo = ((options?: { encoding: BufferEncoding }) => ({ ...real.userInfo(options), homedir: state.home })) as typeof real.userInfo;
  return { ...real, userInfo, default: { ...real, userInfo } };
});

const { userInfo: mockedUserInfo } = await import("node:os");
const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const { configDir } = await import("../../src/profile/paths.js");
const { realProfileDir } = await import("./real-profile.js");
if (mockedUserInfo().homedir === realOs.userInfo().homedir || configDir() === realProfileDir(realOs.userInfo().homedir)) {
  throw new Error("test setup: the profile directory is not redirected to a temporary home");
}

/** The temporary home of this test file. */
export function testHome(): string {
  return mockedUserInfo().homedir;
}

afterAll(async () => {
  const { rmSync } = await import("node:fs");
  rmSync(state.home, { recursive: true, force: true });
});

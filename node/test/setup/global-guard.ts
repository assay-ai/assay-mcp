/**
 * Global guard (review I2): fails the run when the real profile directory of the OS account
 * running the tests changed while they ran. Every test file also gets a temporary home through
 * `test/setup/temp-home.ts`, so `configDir()` never points at the real one.
 */
import { userInfo } from "node:os";
import { fingerprintDir, realProfileDir } from "./real-profile.js";

export default function setup(): () => void {
  return guard(realProfileDir(userInfo().homedir));
}

/** Records `dir` now; the returned teardown throws if it differs later. */
export function guard(dir: string): () => void {
  const before = fingerprintDir(dir);
  return () => {
    const after = fingerprintDir(dir);
    if (after !== before) {
      throw new Error(`a test changed the real profile directory ${dir}:\n--- before\n${before}\n--- after\n${after}`);
    }
  };
}

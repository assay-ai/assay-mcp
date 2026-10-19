/**
 * The real profile directory of the OS account running the tests, and a fingerprint of it
 * (every entry's path, type, size and mtime; "absent" when it does not exist). Uses the real
 * `node:os`, never the mocked one.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDirFor } from "../../src/profile/paths.js";

export function realProfileDir(realHome: string): string {
  return configDirFor({ platform: process.platform, home: realHome });
}

export function fingerprintDir(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      out.push(`${d} absent`);
      return;
    }
    out.push(`${d} ${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"} ${st.size} ${st.mtimeMs} ${st.mode}`);
    if (st.isDirectory()) for (const name of readdirSync(d).sort()) walk(join(d, name));
  };
  walk(dir);
  return out.join("\n");
}

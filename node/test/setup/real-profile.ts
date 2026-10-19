/**
 * The real profile directory of the OS account running the tests, and a fingerprint of it
 * (every entry's path, type, size and mtime; "absent" when it does not exist). Uses the real
 * `node:os`, never the mocked one.
 *
 * The fingerprint covers both the path as given (an `lstat` walk, so a symlink is recorded as
 * one) and the directory it resolves to (review R1-N1): when `{dir}` or a parent is a symlink,
 * a write through it still changes the fingerprint, and so does re-pointing the link.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { configDirFor } from "../../src/profile/paths.js";

export function realProfileDir(realHome: string): string {
  return configDirFor({ platform: process.platform, home: realHome });
}

export function fingerprintDir(dir: string): string {
  let real: string | null;
  try {
    real = realpathSync(dir);
  } catch {
    real = null;
  }
  const views = [walkDir(dir), `resolves to ${real ?? "nothing"}`];
  if (real !== null && real !== dir) views.push(walkDir(real));
  return views.join("\n");
}

/**
 * One `lstat` walk: every entry's path, type, size, mtime and mode. A symlink below the root is
 * recorded as one and then followed (F4 M4): the directory it points at is walked as well, so a
 * write through `{dir}/profiles -> elsewhere` changes the fingerprint. A visited set of real
 * paths ends cycles.
 */
function walkDir(dir: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string) => {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      out.push(`${d} absent`);
      return;
    }
    out.push(`${d} ${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"} ${st.size} ${st.mtimeMs} ${st.mode}`);
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(d);
      } catch {
        out.push(`${d} dangling`);
        return;
      }
      out.push(`${d} resolves to ${target}`);
      if (seen.has(target)) return;
      seen.add(target);
      walkResolved(target);
      return;
    }
    if (st.isDirectory()) for (const name of readdirSync(d).sort()) walk(join(d, name));
  };
  const walkResolved = (target: string) => {
    const st = lstatSync(target);
    out.push(`-> ${target} ${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs} ${st.mode}`);
    if (st.isDirectory()) for (const name of readdirSync(target).sort()) walk(join(target, name));
  };
  walk(dir);
  return out.join("\n");
}

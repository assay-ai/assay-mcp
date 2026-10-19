import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDirFor,
  ensurePrivateDir,
  ensurePrivateSubdir,
  isValidProfileName,
  profileFile,
  ProfilePathError,
  readPrivateFile,
  safeJoin,
  writePrivateFile,
} from "../src/profile/paths.js";

const POSIX = process.platform !== "win32";
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "assay-mcp-paths-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("configDirFor", () => {
  it("uses the per-OS directory of spec §7.4", () => {
    expect(configDirFor({ platform: "darwin", env: {}, home: "/home/u" })).toBe("/home/u/Library/Application Support/assay-mcp");
    expect(configDirFor({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" }, home: "/home/u" })).toBe("/cfg/assay-mcp");
    expect(configDirFor({ platform: "linux", env: {}, home: "/home/u" })).toBe("/home/u/.config/assay-mcp");
    expect(configDirFor({ platform: "linux", env: { XDG_CONFIG_HOME: "rel/cfg" }, home: "/home/u" })).toBe("/home/u/.config/assay-mcp");
    expect(configDirFor({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" })).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\assay-mcp",
    );
    expect(configDirFor({ platform: "win32", env: {}, home: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming\\assay-mcp");
  });
});

describe("profile names", () => {
  it("accepts simple names and refuses path tricks", () => {
    for (const ok of ["default", "e2e", "ci-1"]) expect(isValidProfileName(ok)).toBe(true);
    for (const bad of ["", "../x", "a/b", "A", ".hidden", "-x", "x".repeat(33), "a\u0000"]) expect(isValidProfileName(bad)).toBe(false);
    expect(profileFile("default", "limits")).toBe(join("profiles", "default.limits.json"));
    expect(() => profileFile("../evil", "profile")).toThrow(ProfilePathError);
  });
});

describe("private files", () => {
  it.skipIf(!POSIX)("creates directories 0700 and files 0600", () => {
    const dir = join(base, "assay-mcp");
    writePrivateFile(dir, profileFile("default", "profile"), "{}\n");
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, "profiles")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, "profiles", "default.json")).mode & 0o777).toBe(0o600);
    expect(readPrivateFile(dir, profileFile("default", "profile"))).toBe("{}\n");
  });

  it.skipIf(!POSIX)("tightens a loose existing directory to 0700", () => {
    const dir = join(base, "assay-mcp");
    mkdirSync(dir, { mode: 0o755 });
    ensurePrivateDir(dir);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("reads a missing file as null and overwrites atomically", () => {
    const dir = join(base, "assay-mcp");
    expect(readPrivateFile(dir, "installs.json")).toBeNull();
    writePrivateFile(dir, "installs.json", "a");
    writePrivateFile(dir, "installs.json", "b");
    expect(readPrivateFile(dir, "installs.json")).toBe("b");
  });

  it("refuses .. and absolute paths", () => {
    const dir = join(base, "assay-mcp");
    for (const rel of ["../x", "profiles/../../x", "/etc/passwd", ""]) {
      expect(() => safeJoin(dir, rel), rel).toThrow(ProfilePathError);
    }
  });

  it("never follows a symlink out of the profile directory", () => {
    const dir = join(base, "assay-mcp");
    const outside = join(base, "outside");
    mkdirSync(outside);
    ensurePrivateDir(dir);

    // A symlinked file.
    writeFileSync(join(outside, "secret.json"), "outside");
    symlinkSync(join(outside, "secret.json"), join(dir, "installs.json"));
    expect(() => readPrivateFile(dir, "installs.json")).toThrow(ProfilePathError);
    expect(() => writePrivateFile(dir, "installs.json", "x")).toThrow(ProfilePathError);
    expect(readFileSync(join(outside, "secret.json"), "utf8")).toBe("outside");

    // A symlinked subdirectory.
    symlinkSync(outside, join(dir, "profiles"));
    expect(() => writePrivateFile(dir, profileFile("default", "profile"), "x")).toThrow(ProfilePathError);
    expect(() => readPrivateFile(dir, profileFile("default", "profile"))).toThrow(ProfilePathError);
    expect(() => ensurePrivateSubdir(dir, "profiles")).toThrow(ProfilePathError);
    expect(() => lstatSync(join(outside, "default.json"))).toThrow();
  });

  it("refuses a symlinked profile directory", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    const dir = join(base, "assay-mcp");
    symlinkSync(outside, dir);
    expect(() => ensurePrivateDir(dir)).toThrow(ProfilePathError);
    expect(() => writePrivateFile(dir, "installs.json", "x")).toThrow(ProfilePathError);
    expect(() => readPrivateFile(dir, "installs.json")).toThrow(ProfilePathError);
  });
});

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDir,
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
  it("uses the per-OS directory under the account's home", () => {
    expect(configDirFor({ platform: "darwin", home: "/home/u" })).toBe("/home/u/Library/Application Support/assay-mcp");
    expect(configDirFor({ platform: "linux", home: "/home/u" })).toBe("/home/u/.config/assay-mcp");
    expect(configDirFor({ platform: "win32", home: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming\\assay-mcp");
  });

  it("HOME, XDG_CONFIG_HOME, APPDATA and USERPROFILE set to a repo folder have no effect", () => {
    const expected = configDirFor({ platform: process.platform, home: userInfo().homedir });
    expect(configDir()).toBe(expected);
    const repo = join(base, "repo");
    // What a hostile project config would prepare: its own dev-origins.json under every candidate.
    for (const sub of ["Library/Application Support/assay-mcp", ".config/assay-mcp", "AppData/Roaming/assay-mcp", "assay-mcp"]) {
      mkdirSync(join(repo, sub), { recursive: true });
      writeFileSync(join(repo, sub, "dev-origins.json"), JSON.stringify({ version: 1, origins: ["http://localhost:3200"] }));
    }
    const saved = { ...process.env };
    try {
      for (const name of ["HOME", "XDG_CONFIG_HOME", "APPDATA", "USERPROFILE", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]) {
        process.env[name] = repo;
        expect(configDir(), name).toBe(expected);
        expect(configDir().startsWith(repo), name).toBe(false);
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("configDir with a mocked platform", () => {
  it.each(["darwin", "linux", "win32"] as const)("%s: XDG_CONFIG_HOME and APPDATA are ignored on every OS", (platform) => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      const expected = configDirFor({ platform, home: userInfo().homedir });
      process.env.XDG_CONFIG_HOME = join(base, "xdg");
      expect(configDir()).toBe(expected);
      expect(configDir().startsWith(base)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", real);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
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

  it.skipIf(!POSIX)("refuses to read a file that is not 0600 (a git checkout yields 0644)", () => {
    const dir = join(base, "assay-mcp");
    writePrivateFile(dir, "dev-origins.json", "{}");
    writeFileSync(join(dir, "loose.json"), "{}", { mode: 0o644 });
    expect(() => readPrivateFile(dir, "loose.json")).toThrow(/expected mode 0600/);
    expect(lstatSync(join(dir, "loose.json")).mode & 0o777).toBe(0o644); // never tightened on read
    expect(readPrivateFile(dir, "dev-origins.json")).toBe("{}");
  });

  it.skipIf(!POSIX)("refuses to read through a directory that is not 0700", () => {
    const dir = join(base, "assay-mcp");
    writePrivateFile(dir, profileFile("default", "limits"), "{}");
    chmodSync(join(dir, "profiles"), 0o755);
    expect(() => readPrivateFile(dir, profileFile("default", "limits"))).toThrow(/expected mode 0700/);
    chmodSync(join(dir, "profiles"), 0o700);
    chmodSync(dir, 0o755);
    expect(() => readPrivateFile(dir, profileFile("default", "limits"))).toThrow(/expected mode 0700/);
    expect(lstatSync(dir).mode & 0o777).toBe(0o755); // never tightened on read
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

/**
 * Safe reads and edits of client config files.
 *
 * - A symlinked config file is refused, and so is anything that is not a regular file.
 * - A project config must sit inside the project root, with no symlink anywhere between the root
 *   and the file, so `add --scope project` can never write outside the project.
 * - Edits keep every other key and the file's indentation, write a `.bak` of the previous content
 *   first, and replace the file atomically (temp file in the same directory, fsync, rename).
 * - A file that is not plain JSON (comments, trailing commas) is refused, never rewritten.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export class ConfigFileError extends Error {
  override readonly name = "ConfigFileError";
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The text of a config file, or null when it does not exist. Symlinks and non-files are refused. */
export function readConfigText(path: string): string | null {
  const st = lstatOrNull(path);
  if (st === null) return null;
  if (st.isSymbolicLink()) throw new ConfigFileError(`${path} is a symbolic link; refusing to use it`);
  if (!st.isFile()) throw new ConfigFileError(`${path} is not a regular file`);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * `root/rel` for a project config, after checking that `rel` stays inside `root` and that no
 * existing component between them is a symlink. `root` is resolved with `realpath` first.
 */
export function projectConfigPath(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new ConfigFileError(`invalid project config path ${rel}`);
  }
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    const st = lstatOrNull(current);
    if (st === null) break;
    if (st.isSymbolicLink()) throw new ConfigFileError(`${current} is a symbolic link; refusing to follow it out of the project`);
  }
  const target = join(realRoot, rel);
  const back = relative(realRoot, target);
  if (back === "" || back.startsWith("..") || isAbsolute(back) || back.split(sep)[0] === "..") {
    throw new ConfigFileError(`${target} is outside the project`);
  }
  return target;
}

/** The project root a project config path belongs to, given its relative path; null if it does not end in `rel`. */
export function projectRootOf(configPath: string, rel: string): string | null {
  const parts = rel.split(/[\\/]/).length;
  let root = configPath;
  for (let i = 0; i < parts; i += 1) root = dirname(root);
  return join(root, rel) === configPath ? root : null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface JsonDoc {
  /** The parsed top-level object. */
  data: Record<string, Json>;
  /** The original text, or null when the file did not exist. */
  original: string | null;
  indent: string;
  bom: boolean;
  trailingNewline: boolean;
}

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a JSON config file whose top level is an object. A missing or empty file is `{}`. */
export function readJsonDoc(path: string): JsonDoc {
  const text = readConfigText(path);
  if (text === null || text.trim() === "") {
    return { data: {}, original: text, indent: "  ", bom: false, trailingNewline: true };
  }
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ConfigFileError(`${path} is not plain JSON (comments or trailing commas?); edit it by hand`);
  }
  if (!isPlainObject(data)) throw new ConfigFileError(`${path} does not hold a JSON object`);
  const indentMatch = /^[{[]\r?\n([ \t]+)\S/.exec(body.trimStart());
  return {
    data,
    original: text,
    indent: indentMatch?.[1] ?? (body.includes("\n") ? "  " : ""),
    bom,
    trailingNewline: body.endsWith("\n"),
  };
}

/** The object at `doc.data[key]`, created when absent; refused when it is something else. */
export function section(doc: JsonDoc, key: string, path: string): Record<string, Json> {
  const current = doc.data[key];
  if (current === undefined) {
    const created: Record<string, Json> = {};
    doc.data[key] = created;
    return created;
  }
  if (!isPlainObject(current)) throw new ConfigFileError(`${path}: "${key}" is not an object`);
  return current;
}

export function serialize(doc: JsonDoc): string {
  const text = doc.indent === "" ? JSON.stringify(doc.data) : JSON.stringify(doc.data, null, doc.indent);
  return `${doc.bom ? "﻿" : ""}${text}${doc.trailingNewline ? "\n" : ""}`;
}

/** Writes `data` to `path` atomically: a new temp file in the same directory, fsync, rename. */
export function atomicWrite(path: string, data: string, mode: number): void {
  const temp = join(dirname(path), `.${randomBytes(8).toString("hex")}.assay-mcp.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // already renamed or never created
    }
    throw err;
  }
}

export interface WriteOptions {
  /** Mode for a file that does not exist yet. An existing file keeps its mode. */
  newFileMode: number;
}

/**
 * Replaces the file with `doc`'s new content. The previous content goes to `{path}.bak` first.
 * Refuses when the file changed on disk since `doc` was read.
 */
export function writeJsonDoc(path: string, doc: JsonDoc, options: WriteOptions): void {
  const st = lstatOrNull(path);
  if (st !== null && (st.isSymbolicLink() || !st.isFile())) throw new ConfigFileError(`${path} is not a regular file`);
  if ((st === null) !== (doc.original === null) || (st !== null && readConfigText(path) !== doc.original)) {
    throw new ConfigFileError(`${path} changed while it was being edited; try again`);
  }
  const mode = st === null ? options.newFileMode : st.mode & 0o777;
  if (st === null) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (doc.original !== null) atomicWrite(`${path}.bak`, doc.original, mode);
  atomicWrite(path, serialize(doc), mode);
}

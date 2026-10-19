import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";

/** The first line of every log file `assay-mcp` writes. A file without it is never appended to. */
export const LOG_FILE_HEADER = "# assay-mcp log v1";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const IS_POSIX = process.platform !== "win32";

export class LogFileError extends Error {
  override readonly name = "LogFileError";
}

/** An open `--log-file`: append-only, 0600. */
export interface LogFile {
  readonly path: string;
  write(line: string): void;
  close(): void;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function readHead(fd: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, 0);
  return buf.subarray(0, n).toString("utf8");
}

/**
 * Opens `path` for `--log-file` (spec §7.3):
 * - a new file is created 0600 (exclusively, never through a symlink) and starts with the header;
 * - an existing file is appended to only when it is a regular file, not a symlink, and its
 *   first line is the header; it is tightened to 0600.
 */
export function openLogFile(path: string): LogFile {
  const before = lstatOrNull(path);
  let fd: number;
  if (before === null) {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | NOFOLLOW, 0o600);
    } catch (err) {
      throw new LogFileError(`cannot create the log file (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    writeSync(fd, `${LOG_FILE_HEADER}\n`);
  } else {
    if (before.isSymbolicLink()) throw new LogFileError("the log file is a symbolic link; refusing to write to it");
    if (!before.isFile()) throw new LogFileError("the log file is not a regular file");
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | NOFOLLOW);
    } catch (err) {
      throw new LogFileError(`cannot open the log file (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    const after = fstatSync(fd);
    // The path must still name the file that was checked (no swap between lstat and open).
    if (after.ino !== before.ino || after.dev !== before.dev || !after.isFile()) {
      closeSync(fd);
      throw new LogFileError("the log file changed while it was being opened");
    }
    if (IS_POSIX && typeof process.getuid === "function" && after.uid !== process.getuid()) {
      closeSync(fd);
      throw new LogFileError("the log file belongs to another user");
    }
    const head = readHead(fd, LOG_FILE_HEADER.length + 1);
    if (head !== `${LOG_FILE_HEADER}\n`) {
      closeSync(fd);
      throw new LogFileError(`the log file was not written by assay-mcp (its first line is not "${LOG_FILE_HEADER}")`);
    }
    // Tighten through the descriptor, never the path.
    if (IS_POSIX && (after.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  }
  let open = true;
  return {
    path,
    write(line: string) {
      if (!open) return;
      try {
        writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
      } catch {
        // A full disk or a revoked descriptor must not take the proxy down.
      }
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

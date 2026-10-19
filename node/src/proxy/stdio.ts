import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./protocol.js";

/**
 * The MCP stdio transport: newline-delimited JSON-RPC (spec §7.6, R-MCP-3).
 *
 * stdout carries nothing but JSON-RPC: {@link StdoutWriter} is the only writer, and it only
 * accepts a message object, which it serialises itself. `JSON.stringify` never emits a raw
 * newline, so one message is always exactly one line, whatever a remote put in its strings.
 */

/** The largest message read from the host: larger lines are discarded whole. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export type LineEvent = { kind: "line"; text: string } | { kind: "oversized" };

/**
 * Splits a byte stream into lines. A line longer than `maxBytes` is dropped (its bytes are
 * skipped up to the next newline) and reported once as `oversized`.
 */
export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private skipping = false;

  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer): LineEvent[] {
    const out: LineEvent[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (!this.skipping) {
        if (this.size + piece.length > this.maxBytes) {
          this.parts = [];
          this.size = 0;
          this.skipping = true;
          out.push({ kind: "oversized" });
        } else if (piece.length > 0) {
          this.parts.push(piece);
          this.size += piece.length;
        }
      }
      if (nl === -1) break;
      if (!this.skipping) {
        const line = Buffer.concat(this.parts, this.size).toString("utf8").replace(/\r$/, "");
        if (line.trim() !== "") out.push({ kind: "line", text: line });
      }
      this.parts = [];
      this.size = 0;
      this.skipping = false;
      start = nl + 1;
    }
    return out;
  }

  /** The unterminated last line, at end of input. */
  end(): LineEvent[] {
    if (this.skipping || this.size === 0) return [];
    const line = Buffer.concat(this.parts, this.size).toString("utf8").replace(/\r$/, "");
    this.parts = [];
    this.size = 0;
    return line.trim() === "" ? [] : [{ kind: "line", text: line }];
  }
}

/** Reads lines from `input` until it ends. */
export function readLines(input: Readable, onEvent: (e: LineEvent) => void, onEnd: () => void, maxBytes = MAX_LINE_BYTES): void {
  const splitter = new LineSplitter(maxBytes);
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    for (const e of splitter.end()) onEvent(e);
    onEnd();
  };
  input.on("data", (chunk: Buffer | string) => {
    for (const e of splitter.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)) onEvent(e);
  });
  input.on("end", finish);
  input.on("close", finish);
  input.on("error", finish);
}

/** The one writer of stdout. */
export class StdoutWriter {
  private closed = false;

  constructor(
    private readonly out: Writable,
    private readonly onClosed: () => void = () => {},
  ) {
    out.on("error", () => this.close());
  }

  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      return; // not serialisable (cannot happen for parsed JSON): nothing is written
    }
    try {
      this.out.write(line);
    } catch {
      this.close();
    }
  }

  /** Resolves once everything written so far has been handed to the OS. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        this.out.write("", () => resolve());
      } catch {
        resolve();
      }
    });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
  }
}

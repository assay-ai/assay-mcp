// Kept apart from keychain.ts so the entry point can read it without loading the native keyring.

let timedOut = false;

/** Records that a startup keychain probe gave up on a keychain that never answered. */
export function markKeychainProbeTimedOut(): void {
  timedOut = true;
}

/**
 * Whether a startup probe gave up on a keychain that never answered. The read it left behind
 * still holds the process open, so the entry point exits explicitly when this is true.
 */
export function keychainProbeTimedOut(): boolean {
  return timedOut;
}

/**
 * Ends the process with `code`. After a probe that timed out, a normal exit would hang: the
 * keyring read stuck on the unlock prompt holds a libuv worker thread, and exiting waits for every
 * worker. The process is then killed instead; the text was already written to stderr.
 */
export function exitProcess(code: number): never {
  if (timedOut) process.kill(process.pid, "SIGKILL");
  process.exit(code);
}

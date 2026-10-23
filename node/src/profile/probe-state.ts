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

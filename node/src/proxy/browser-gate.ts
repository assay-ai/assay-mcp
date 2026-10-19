import { withLock, type LockOptions, type ProfileRef } from "../profile/lock.js";
import { updateState } from "../profile/profile.js";

/**
 * The enable-paid browser gate (R-MCP-10): the page opens at most once per 10 minutes per
 * profile, across every process of that profile. The decision and the record
 * (`state.json` `lastBrowserOpen`, Unix seconds) are made in one hold of the profile lock, so
 * two processes cannot both decide to open. The browser itself is launched after the lock is
 * released.
 */

export const BROWSER_GATE_SECONDS = 600;

export interface GateOptions extends LockOptions {
  /** Milliseconds clock. */
  readonly now?: () => number;
}

/**
 * Opens `url` through `open` unless the profile opened a browser in the last 10 minutes.
 * Returns whether it was opened. Never throws: a lock or state failure means "not opened".
 */
export async function openThroughGate(profile: ProfileRef, url: string, open: (url: string) => Promise<boolean>, options: GateOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  let allowed = false;
  try {
    await withLock(
      profile,
      (lock) => {
        updateState(profile, lock, (state) => {
          const nowSeconds = Math.floor(now() / 1000);
          const last = state.lastBrowserOpen;
          // A record up to 10 minutes in the future (small clock moves) counts as recent; one
          // further ahead (a clock moved back a long way) does not block the page for longer.
          if (last !== null && Math.abs(nowSeconds - last) < BROWSER_GATE_SECONDS) return state;
          allowed = true;
          return { ...state, lastBrowserOpen: nowSeconds };
        });
      },
      options,
    );
  } catch {
    return false;
  }
  if (!allowed) return false;
  try {
    return await open(url);
  } catch {
    return false;
  }
}

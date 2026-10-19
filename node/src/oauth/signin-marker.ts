import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { LockHandle, ProfileRef } from "../profile/lock.js";
import { profileFile, readPrivateFile, safeJoin, writePrivateFile } from "../profile/paths.js";

/**
 * The "sign-in in progress" marker, `profiles/{profile}.signin.json` (0600):
 * `{version, pid, startedAt, token, passive}`.
 *
 * F1 waits for the browser without the profile lock (fix round 1 of Task 2.8): the lock is
 * taken only to claim the marker and, after the callback, to exchange and store. The marker
 * stops a second process from starting its own browser flow while one is pending. It is live
 * for {@link MARKER_TTL_MS} (the loopback's own limit) and only while its pid runs.
 *
 * A *passive* marker belongs to a sign-in that only printed its link at startup (§7.6 step 4).
 * An active sign-in (`assay_sign_in`, `login`) may take it over; the passive flow can still
 * finish if its link is used, and the keychain re-read under the lock then keeps one grant.
 */

export const MARKER_TTL_MS = 5 * 60_000;

export interface SignInMarker {
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
  readonly passive: boolean;
}

function rel(profile: ProfileRef): string {
  return profileFile(profile.name, "signin");
}

/** The marker on disk; `null` when missing or unreadable (an unreadable marker is never live). */
export function readMarker(profile: ProfileRef): SignInMarker | null {
  try {
    const text = readPrivateFile(profile.dir, rel(profile));
    if (text === null) return null;
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v.version !== 1 || !Number.isSafeInteger(v.pid) || !Number.isSafeInteger(v.startedAt) || typeof v.token !== "string" || typeof v.passive !== "boolean") return null;
    return { pid: v.pid as number, startedAt: v.startedAt as number, token: v.token, passive: v.passive };
  } catch {
    return null;
  }
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isLive(marker: SignInMarker, nowMs: number, alive: (pid: number) => boolean = pidAlive): boolean {
  return nowMs - marker.startedAt < MARKER_TTL_MS && nowMs >= marker.startedAt - 60_000 && alive(marker.pid);
}

export type Claim = { kind: "claimed"; marker: SignInMarker } | { kind: "busy"; marker: SignInMarker };

/**
 * Claims the marker under the profile lock. Refused (`busy`) when a live marker exists,
 * unless it is passive and this sign-in is active.
 */
export function claimMarker(profile: ProfileRef, lock: LockHandle, passive: boolean, nowMs: number, alive?: (pid: number) => boolean): Claim {
  lock.assertHeld(); // the read and the write below are atomic only under the profile lock
  const current = readMarker(profile);
  if (current !== null && isLive(current, nowMs, alive) && (passive || !current.passive)) return { kind: "busy", marker: current };
  const marker: SignInMarker = { pid: process.pid, startedAt: nowMs, token: randomBytes(16).toString("base64url"), passive };
  lock.assertHeld();
  write(profile, marker);
  return { kind: "claimed", marker };
}

function write(profile: ProfileRef, marker: SignInMarker): void {
  writePrivateFile(profile.dir, rel(profile), `${JSON.stringify({ version: 1, ...marker })}\n`);
}

/**
 * Marks this process's passive marker active, under the profile lock. Returns false when the
 * marker is no longer ours (an active sign-in elsewhere took it over): the caller must not
 * open a browser. Claims and activations are serialised by the lock, so at most one browser
 * flow runs for a profile.
 */
export function activateMarker(profile: ProfileRef, lock: LockHandle, token: string): boolean {
  const current = readMarker(profile);
  if (current?.token !== token) return false;
  if (current.passive) {
    lock.assertHeld();
    write(profile, { ...current, passive: false });
  }
  return true;
}

/** Removes the marker if it is still ours. */
export function releaseMarker(profile: ProfileRef, token: string): void {
  try {
    if (readMarker(profile)?.token !== token) return;
    unlinkSync(safeJoin(profile.dir, rel(profile)));
  } catch {
    // already gone; a leftover expires on its own
  }
}

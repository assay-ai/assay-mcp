import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainReader, DelegationResult } from "../src/chain/reads.js";
import { silentLogger } from "../src/log/logger.js";
import { DELEGATE_PATH, DELEGATE_STATUS_PATH, POLL_MAX_MS, startEnablePoll, type ApiGet } from "../src/proxy/enable-poll.js";

/** The enable-paid wait in isolation: fake timers, a scripted chain and a scripted API. */

const NET = "eip155:46630";
/** Public anvil default accounts (test only). */
const PAYER = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const KEY = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").address;
const OTHER = getAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65");
const caip = (a: string) => `${NET}:${a}`;

function grant(active: boolean): DelegationResult {
  return {
    ok: true,
    value: {
      payer: PAYER,
      delegate: KEY,
      active,
      validUntil: active ? String(Math.floor(Date.now() / 1000) + 86_400) : "0",
      maxVoucherAmount: "500000",
      maxPerWindow: "5000000",
      delegateMaxVoucherAmount: active ? "500000" : "0",
      delegateMaxPerWindow: "5000000",
      readAt: Math.floor(Date.now() / 1000),
    },
  };
}

/** The world the wait sees: what the chain says, what each route answers, and every request. */
function world() {
  const w = {
    live: false,
    statusRoute: true as boolean,
    statusFails: 0,
    serverStatus: "ACTIVE" as string,
    boundTo: KEY as string | null,
    gets: [] as string[],
    reads: [] as { fresh: boolean | undefined }[],
    invalidated: 0,
    active: 0,
    ended: 0,
  };
  const chain: ChainReader = {
    readDelegation: async (_network, _payer, _delegate, opts) => {
      w.reads.push({ fresh: opts?.fresh });
      return grant(w.live);
    },
    invalidate: () => {
      w.invalidated++;
    },
    clear: () => {},
  };
  const get: ApiGet = async (path) => {
    w.gets.push(path);
    if (path === DELEGATE_STATUS_PATH) {
      if (!w.statusRoute) return "not-found";
      if (w.statusFails > 0) {
        w.statusFails--;
        return null;
      }
      return { body: { data: { credentialId: "c", agentLabel: "agent", bound: w.boundTo !== null, delegate: w.boundTo && caip(w.boundTo), boundAt: null } } };
    }
    if (path === DELEGATE_PATH) {
      // The full route reads the chain on the backend: ACTIVE only once the grant is there.
      const status = w.live ? w.serverStatus : "NONE";
      return { body: { data: { delegate: w.boundTo && caip(w.boundTo), paidCalls: { status } } } };
    }
    return null;
  };
  const start = (extra: { pollMs?: number } = {}) =>
    startEnablePoll({
      network: NET,
      payer: PAYER,
      address: KEY,
      chain,
      get,
      now: () => Date.now(),
      log: silentLogger,
      onActive: () => {
        w.active++;
      },
      onEnd: () => {
        w.ended++;
      },
      ...extra,
    });
  return { w, start };
}

const tick = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enable-paid wait (F4 step 6)", () => {
  it("detects ACTIVE through a fresh chain read; the full route is read once, at the end", async () => {
    const { w, start } = world();
    start();
    await tick(); // probe + chain read (not yet)
    await tick();
    await tick();
    expect(w.active).toBe(0);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH]);
    expect(w.reads).toHaveLength(3);
    expect(w.reads.every((r) => r.fresh === true)).toBe(true);
    // A read that showed no grant is not left in the 10-minute cache.
    expect(w.invalidated).toBe(3);

    w.live = true; // the person approved on the page
    await tick();
    expect(w.active).toBe(1);
    expect(w.ended).toBe(1);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH, DELEGATE_PATH]);

    // Ended: nothing more is read.
    await tick(60_000);
    expect(w.reads).toHaveLength(4);
    expect(w.gets).toHaveLength(2);
  });

  it("no backend request per tick while waiting", async () => {
    const { w, start } = world();
    start();
    await tick(20 * 5_000);
    expect(w.reads).toHaveLength(20);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH]);
    expect(w.active).toBe(0);
  });

  it("falls back to the full route on every tick when the status route is a 404 (older backend)", async () => {
    const { w, start } = world();
    w.statusRoute = false;
    start();
    await tick(3 * 5_000);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH, DELEGATE_PATH, DELEGATE_PATH, DELEGATE_PATH]);
    // As before: the chain is read only once the server says ACTIVE.
    expect(w.reads).toHaveLength(0);

    w.live = true;
    await tick();
    expect(w.active).toBe(1);
    expect(w.reads).toEqual([{ fresh: true }]);
    expect(w.gets.filter((p) => p === DELEGATE_STATUS_PATH)).toHaveLength(1);
  });

  it("a failed probe (not a 404) is tried again at most 3 times; the chain is read meanwhile", async () => {
    const { w, start } = world();
    w.statusFails = 10;
    start();
    await tick(10 * 5_000);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH, DELEGATE_STATUS_PATH, DELEGATE_STATUS_PATH]);
    expect(w.reads).toHaveLength(10);
  });

  it("the chain is live but Assay does not say ACTIVE for this key: not on, and the wait goes on", async () => {
    const { w, start } = world();
    w.live = true;
    w.boundTo = OTHER; // another window bound another key to the credential
    start();
    await tick();
    expect(w.active).toBe(0);
    w.boundTo = KEY;
    w.serverStatus = "NONE";
    await tick();
    expect(w.active).toBe(0);
    w.serverStatus = "ACTIVE";
    await tick();
    expect(w.active).toBe(1);
  });

  it("ends after 15 minutes: every 5 s for 2 minutes, then every 15 s; the backend is asked once", async () => {
    const { w, start } = world();
    start();
    await tick(2 * 60_000);
    expect(w.reads).toHaveLength(24);
    await tick(15_000);
    expect(w.reads).toHaveLength(25);
    await tick(POLL_MAX_MS);
    expect(w.ended).toBe(1);
    expect(w.active).toBe(0);
    // 24 fast reads, then one every 15 s up to the 15-minute mark (was 180 backend requests).
    expect(w.reads).toHaveLength(24 + 52);
    expect(w.gets).toEqual([DELEGATE_STATUS_PATH]);
    w.live = true;
    await tick(60_000);
    expect(w.reads).toHaveLength(76);
    expect(w.active).toBe(0);
  });

  it("stop() ends the wait (process end)", async () => {
    const { w, start } = world();
    const handle = start();
    await tick();
    handle.stop();
    await tick(60_000);
    expect(w.reads).toHaveLength(1);
    expect(w.ended).toBe(1);
  });
});

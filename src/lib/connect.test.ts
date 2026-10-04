import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { interleave, lookupAll, raceConnect, type Address } from "./connect";

/**
 * A stand-in for one connection attempt: it connects after `connectMs`,
 * fails with `code` after `failMs`, or never answers.
 */
function attempt(plan: { connectMs?: number; failMs?: number; code?: string }) {
  const socket = new EventEmitter() as unknown as Socket & {
    destroyed: boolean;
  };
  socket.destroyed = false;
  const timer =
    plan.connectMs !== undefined
      ? setTimeout(() => socket.emit("connect"), plan.connectMs)
      : plan.failMs !== undefined
        ? setTimeout(
            () =>
              socket.emit(
                "error",
                Object.assign(new Error(plan.code ?? "ECONNREFUSED"), {
                  code: plan.code ?? "ECONNREFUSED",
                }),
              ),
            plan.failMs,
          )
        : null;
  (socket as unknown as { destroy: () => void }).destroy = () => {
    socket.destroyed = true;
    if (timer) clearTimeout(timer);
  };
  return socket;
}

const V6A: Address = { address: "2001:db8::1", family: 6 };
const V6B: Address = { address: "2001:db8::2", family: 6 };
const V4A: Address = { address: "192.0.2.1", family: 4 };
const V4B: Address = { address: "192.0.2.2", family: 4 };

/** Races `addresses` against planned attempts, keyed by address. */
function race(
  addresses: Address[],
  plans: Record<string, Parameters<typeof attempt>[0]>,
  timeoutMs = 2000,
) {
  const dialled: string[] = [];
  const sockets = new Map<string, ReturnType<typeof attempt>>();
  const result = raceConnect(addresses, 443, {
    timeoutMs,
    dial: (target) => {
      dialled.push(target.address);
      const socket = attempt(plans[target.address] ?? {});
      sockets.set(target.address, socket);
      return socket;
    },
  });
  return { result, dialled, sockets };
}

describe("racing a host's addresses", () => {
  it("takes the families in turns, starting with the first", () => {
    expect(interleave([V6A, V6B, V4A, V4B]).map((a) => a.address)).toEqual([
      V6A.address,
      V4A.address,
      V6B.address,
      V4B.address,
    ]);
    expect(interleave([V4A, V6A, V6B]).map((a) => a.address)).toEqual([
      V4A.address,
      V6A.address,
      V6B.address,
    ]);
  });

  it("connects a far host on its first address, where dropping it after a quarter second would not", async () => {
    // A 300 ms round trip on every address: Node's own fallback reads
    // (n - 1) x 250 ms more; the race keeps the first attempt going.
    const { result, dialled } = race([V6A, V4A, V6B, V4B], {
      [V6A.address]: { connectMs: 300 },
      [V4A.address]: { connectMs: 300 },
      [V6B.address]: { connectMs: 300 },
      [V4B.address]: { connectMs: 300 },
    });
    const won = await result;
    expect(won.address).toBe(V6A.address);
    expect(won.connectMs).toBeGreaterThanOrEqual(290);
    expect(won.connectMs).toBeLessThan(400);
    expect(dialled).toEqual([V6A.address, V4A.address]);
  });

  it("starts the next address after a quarter second when the first is silent", async () => {
    const { result, sockets } = race([V6A, V4A], {
      [V4A.address]: { connectMs: 20 },
    });
    const won = await result;
    expect(won.address).toBe(V4A.address);
    expect(won.connectMs).toBeGreaterThanOrEqual(260);
    expect(won.connectMs).toBeLessThan(400);
    // The silent attempt is closed once the other wins.
    expect(sockets.get(V6A.address)?.destroyed).toBe(true);
  });

  it("moves on at once from an address that fails, as IPv6 does on a box without it", async () => {
    const { result } = race([V6A, V4A], {
      [V6A.address]: { failMs: 1, code: "ENETUNREACH" },
      [V4A.address]: { connectMs: 20 },
    });
    const won = await result;
    expect(won.address).toBe(V4A.address);
    expect(won.connectMs).toBeLessThan(150);
  });

  it("reports the last failure when every address fails, and times out on silence", async () => {
    const failing = race([V6A, V4A], {
      [V6A.address]: { failMs: 5, code: "ENETUNREACH" },
      [V4A.address]: { failMs: 10, code: "ECONNREFUSED" },
    });
    await expect(failing.result).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    const silent = race([V4A], {}, 300);
    await expect(silent.result).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(silent.sockets.get(V4A.address)?.destroyed).toBe(true);
  });

  it("has nothing to race without an address", async () => {
    await expect(race([], {}).result).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });
});

describe("lookupAll", () => {
  it("needs no lookup for an IP address, bracketed or not", async () => {
    expect(await lookupAll("192.0.2.1", 1000)).toEqual([
      { address: "192.0.2.1", family: 4 },
    ]);
    expect(await lookupAll("[2001:db8::1]", 1000)).toEqual([
      { address: "2001:db8::1", family: 6 },
    ]);
  });

  it("gives every address of a name", async () => {
    const addresses = await lookupAll("localhost", 5000);
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((a) => a.family === 4 || a.family === 6)).toBe(true);
  });

  it("rejects with the resolver's code", async () => {
    await expect(lookupAll("no-such-host.invalid", 5000)).rejects.toMatchObject(
      {
        code: expect.stringMatching(/ENOTFOUND|EAI_AGAIN/),
      },
    );
  });
});

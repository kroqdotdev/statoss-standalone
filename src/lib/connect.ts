import { promises as dns } from "node:dns";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * How a check opens its connection, and how long each step takes. A host
 * can answer on several addresses, IPv6 and IPv4. Node's own fallback gives
 * each address a quarter second and then drops it for the next, so a far
 * host whose round trip is longer than that never connects on its first
 * address and reads a quarter second slower for each one it has; with many
 * checks at once, a busy event loop makes that worse. Here the attempts
 * race instead, as RFC 8305 has it: the next address starts after a
 * quarter second without the earlier one being dropped, the families take
 * turns, and the first connection wins.
 *
 * Every time here is read from the monotonic clock, so a change to the
 * system clock cannot make a check read slow or negative.
 */

/** How long an attempt runs alone before the next address starts. */
export const ATTEMPT_DELAY_MS = 250;

export interface Address {
  address: string;
  family: number;
}

export interface Raced {
  /** Connected. */
  socket: Socket;
  /** The address that answered first. */
  address: string;
  family: number;
  /** From the first attempt to the connection. */
  connectMs: number;
}

/** Milliseconds since `start` on the monotonic clock, whole and never negative. */
export function since(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/** An error with a code, the way Node's own socket and lookup errors have one. */
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The addresses in the order they are tried: the first as the resolver
 * gave it, then the families taking turns, each in its own order.
 */
export function interleave(addresses: Address[]): Address[] {
  if (addresses.length < 2) return addresses.slice();
  const first = addresses[0].family;
  const same = addresses.filter((a) => a.family === first);
  const other = addresses.filter((a) => a.family !== first);
  const out: Address[] = [];
  for (let i = 0; i < Math.max(same.length, other.length); i++) {
    if (i < same.length) out.push(same[i]);
    if (i < other.length) out.push(other[i]);
  }
  return out;
}

/**
 * Every address of a host, or a rejection with the resolver's code. A
 * resolver that has not answered within `timeoutMs` rejects with
 * ETIMEDOUT. An IP literal is its own address and needs no lookup.
 */
export function lookupAll(host: string, timeoutMs: number): Promise<Address[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family) return Promise.resolve([{ address: bare, family }]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(codedError(`lookup timeout ${bare}`, "ETIMEDOUT")),
      timeoutMs,
    );
    dns
      .lookup(bare, { all: true })
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

export interface RaceOptions {
  timeoutMs: number;
  attemptDelayMs?: number;
  /** Opens one attempt. Tests stand in for the network with it. */
  dial?: (target: Address, port: number) => Socket;
}

/**
 * Connects to the first of `addresses` to answer. An attempt that fails
 * starts the next at once; one that is still waiting after the attempt
 * delay keeps waiting while the next starts beside it. The losers are
 * closed. Rejects with the last attempt's error when every address fails,
 * or with ETIMEDOUT after `timeoutMs`.
 */
export function raceConnect(
  addresses: Address[],
  port: number,
  options: RaceOptions,
): Promise<Raced> {
  const order = interleave(addresses);
  const delay = options.attemptDelayMs ?? ATTEMPT_DELAY_MS;
  const dial =
    options.dial ??
    ((target: Address, targetPort: number) =>
      createConnection({
        host: target.address,
        port: targetPort,
        family: target.family,
      }));
  const start = performance.now();
  return new Promise((resolve, reject) => {
    if (order.length === 0) {
      reject(codedError("no addresses", "ENOTFOUND"));
      return;
    }
    const attempts = new Set<Socket>();
    let next = 0;
    let failed = 0;
    let done = false;
    let lastError: Error | null = null;
    let stagger: ReturnType<typeof setTimeout> | null = null;
    const overall = setTimeout(
      () => finish(null, codedError("connect timeout", "ETIMEDOUT")),
      options.timeoutMs,
    );

    const finish = (won: Raced | null, err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (stagger) clearTimeout(stagger);
      for (const socket of attempts)
        if (!won || socket !== won.socket) socket.destroy();
      attempts.clear();
      if (won) resolve(won);
      else reject(err ?? codedError("connect failed", "ECONNREFUSED"));
    };

    const startNext = () => {
      if (done || next >= order.length) return;
      if (stagger) clearTimeout(stagger);
      stagger = null;
      const target = order[next++];
      const socket = dial(target, port);
      attempts.add(socket);
      const onError = (err: Error) => {
        attempts.delete(socket);
        socket.destroy();
        if (done) return;
        lastError = err;
        failed++;
        if (failed >= order.length) finish(null, lastError);
        // A failure hands its turn to the next address at once.
        else startNext();
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        attempts.delete(socket);
        socket.removeListener("error", onError);
        // Until the caller takes the socket over, an error must not throw.
        socket.on("error", () => {});
        finish(
          {
            socket,
            address: target.address,
            family: target.family,
            connectMs: since(start),
          },
          null,
        );
      });
      if (next < order.length) stagger = setTimeout(startNext, delay);
    };

    startNext();
  });
}

/**
 * What one check's connections took, added up over every connection it
 * opened, so a check across redirects to other hosts counts them all.
 * The lookup counts however it ended, 0 for an IP address; a connection
 * or a handshake only once it finished. Null until then.
 */
export interface ConnectTiming {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  /** When the lookup still under way began, so a check that gives up on it can count its time. */
  lookingUp: number | null;
}

const add = (sum: number | null, ms: number) => (sum ?? 0) + ms;

/** The time spent looking up so far, the lookup under way included. */
export function lookupMs(timing: ConnectTiming): number | null {
  return timing.lookingUp === null
    ? timing.dnsMs
    : add(timing.dnsMs, since(timing.lookingUp));
}

type ConnectorOptions = {
  hostname: string;
  protocol: string;
  port: string | number;
  servername?: string | null;
};
type ConnectorCallback = (err: Error | null, socket?: Socket) => void;

/**
 * A connector for an undici Agent: looks the host up, races its addresses
 * and adds TLS on the winner, each step timed into `timing`. A connection
 * gives up after `timeoutMs`, so nothing is left open behind a check.
 */
export function racingConnector(timing: ConnectTiming, timeoutMs: number) {
  return (opts: ConnectorOptions, callback: ConnectorCallback): void => {
    const begun = performance.now();
    const left = () => Math.max(1, timeoutMs - since(begun));
    const hostname = opts.hostname.replace(/^\[|\]$/g, "");
    const https = opts.protocol === "https:";
    const port = Number(opts.port) || (https ? 443 : 80);
    const literal = isIP(hostname) !== 0;
    const lookupStart = performance.now();
    timing.lookingUp = lookupStart;
    lookupAll(hostname, timeoutMs)
      .finally(() => {
        timing.lookingUp = null;
        timing.dnsMs = add(timing.dnsMs, since(lookupStart));
      })
      .then((addresses) => raceConnect(addresses, port, { timeoutMs: left() }))
      .then(({ socket, connectMs }) => {
        timing.connectMs = add(timing.connectMs, connectMs);
        socket.setNoDelay(true);
        if (!https) {
          callback(null, socket);
          return;
        }
        const tlsStart = performance.now();
        const servername = opts.servername || (literal ? undefined : hostname);
        const secure = tlsConnect({
          socket,
          host: hostname,
          ...(servername ? { servername } : {}),
          ALPNProtocols: ["http/1.1"],
        });
        let settled = false;
        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          secure.destroy();
          callback(err);
        };
        const timer = setTimeout(
          () => onError(codedError("TLS handshake timeout", "ETIMEDOUT")),
          left(),
        );
        secure.once("error", onError);
        secure.once("secureConnect", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          secure.removeListener("error", onError);
          timing.tlsMs = add(timing.tlsMs, since(tlsStart));
          callback(null, secure);
        });
      })
      .catch((err: unknown) =>
        callback(err instanceof Error ? err : new Error(String(err))),
      );
  };
}

/** What a check needs of an undici Agent: to hand it to fetch, and to close it. */
export interface UndiciAgent {
  destroy(): Promise<void>;
}

/**
 * Node's fetch is undici, and undici keeps its default Agent under a
 * global symbol; another of the same kind needs no dependency. Returns a
 * new Agent with these options, or null where there is none to copy, as
 * when a proxy agent has taken its place: the caller then uses fetch's own
 * connections, untimed.
 */
export function undiciAgent(options: object): UndiciAgent | null {
  new Headers(); // loads Node's undici, which sets the global dispatcher
  const current = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { constructor?: unknown } | undefined;
  const Agent = current?.constructor as
    (new (options: object) => UndiciAgent) | undefined;
  if (typeof Agent !== "function" || Agent.name !== "Agent") return null;
  return new Agent(options);
}

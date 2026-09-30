import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAlertEmail,
  describeAlert,
  formatDuration,
  RETRY_DELAYS_MS,
  describeNotice,
  sendAlerts,
  sendNotice,
  signWebhook,
  slackPayload,
  webhookPayload,
  type AlertEvent,
  type Mail,
  type NoticeEvent,
} from "./alerts";

const NOW = 1_700_000_000_000;

const DOWN: AlertEvent = {
  kind: "went-down",
  site: "webhooks.cc",
  monitor: "Redirector",
  url: "https://go.webhooks.cc",
  pageUrl: "https://status.webhooks.cc",
  error: "timeout",
  now: NOW,
};

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(3 * 60_000)).toBe("3 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
  });
});

describe("buildAlertEmail", () => {
  it("describes a down transition with the error and the page link", () => {
    const { subject, text } = buildAlertEmail(DOWN);
    expect(subject).toBe("webhooks.cc: Redirector is down");
    expect(text).toContain("https://go.webhooks.cc");
    expect(text).toContain("timeout");
    expect(text).toContain("2023-11-14 22:13 UTC");
    expect(text).toContain("https://status.webhooks.cc");
  });

  it("describes a recovery with the outage duration", () => {
    const { subject, text } = buildAlertEmail({
      ...DOWN,
      kind: "recovered",
      downSince: NOW - 10 * 60_000,
    });
    expect(subject).toContain("recovered");
    expect(text).toContain("10 min");
  });

  it("describes slowness with the response time and threshold", () => {
    const { subject, lines } = describeAlert({
      ...DOWN,
      kind: "went-slow",
      latencyMs: 1800,
      thresholdMs: 1000,
    });
    expect(subject).toContain("is slow");
    expect(lines[1]).toBe(
      "Response time: 1,800 ms, over the 1,000 ms threshold",
    );
  });

  it("describes a repeat notice with how long it has been down", () => {
    const { subject, lines } = describeAlert({
      ...DOWN,
      kind: "still-down",
      downSince: NOW - 90 * 60_000,
    });
    expect(subject).toContain("still down");
    expect(lines[0]).toContain("1 h 30 min");
  });
});

describe("signWebhook", () => {
  it("is an HMAC SHA-256 over the body", () => {
    expect(webhookPayload(DOWN)).toMatchObject({
      monitor: "Redirector",
      checkpoint: "Redirector",
    });
    const body = JSON.stringify(webhookPayload(DOWN));
    const expected = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(signWebhook("s3cret", body)).toBe(`sha256=${expected}`);
  });
});

function fakeFetch() {
  const calls: Array<{
    url: string;
    body: string;
    headers: Record<string, string>;
  }> = [];
  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      });
      return new Response("ok", { status: 200 });
    },
  ) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("sendAlerts", () => {
  it("emails with the configured sender to every email destination", async () => {
    const send = vi.fn<(mail: Mail) => Promise<unknown>>().mockResolvedValue(1);
    const { fetchFn } = fakeFetch();
    const results = await sendAlerts(
      [{ email: "a@example.com" }, { email: "b@example.com" }],
      DOWN,
      { send, from: "status@example.com", fetch: fetchFn },
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({
      from: "status@example.com",
      to: "a@example.com",
      subject: "webhooks.cc: Redirector is down",
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("skips email destinations when there is no SMTP", async () => {
    const { fetchFn } = fakeFetch();
    const results = await sendAlerts([{ email: "a@example.com" }], DOWN, {
      send: null,
      from: "",
      fetch: fetchFn,
    });
    expect(results).toEqual([]);
  });

  it("posts to Slack, Discord and a signed webhook", async () => {
    const { calls, fetchFn } = fakeFetch();
    await sendAlerts(
      [
        { slack: "https://hooks.slack.com/x" },
        { discord: "https://discord.com/api/webhooks/y" },
        { webhook: "https://example.com/hook", secret: "s3cret" },
      ],
      DOWN,
      { send: null, from: "", fetch: fetchFn },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://hooks.slack.com/x",
      "https://discord.com/api/webhooks/y",
      "https://example.com/hook",
    ]);
    expect(JSON.parse(calls[0].body)).toEqual(slackPayload(DOWN));
    expect(JSON.parse(calls[1].body).content).toContain(
      "webhooks.cc: Redirector is down",
    );
    const hook = JSON.parse(calls[2].body);
    expect(hook).toMatchObject({
      event: "went-down",
      site: "webhooks.cc",
      monitor: "Redirector",
      error: "timeout",
      at: NOW,
    });
    expect(calls[2].headers["x-statoss-event"]).toBe("went-down");
    expect(calls[2].headers["x-statoss-signature"]).toBe(
      signWebhook("s3cret", calls[2].body),
    );
  });

  it("reports each failure on its own and never throws", async () => {
    const send = vi
      .fn<(mail: Mail) => Promise<unknown>>()
      .mockRejectedValue(new Error("smtp down"));
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await sendAlerts(
      [{ email: "a@example.com" }, { slack: "https://hooks.slack.com/x" }],
      DOWN,
      { send, from: "f", fetch: fetchFn },
    );
    expect(results).toEqual([
      { channel: "email", ok: false, error: "smtp down" },
      { channel: "slack", ok: false, error: "hooks.slack.com answered 500" },
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

describe("PagerDuty, Opsgenie and ntfy", () => {
  it("opens on PagerDuty when a monitor goes down and resolves under the same key", async () => {
    const { calls, fetchFn } = fakeFetch();
    const deps = { send: null, from: "", fetch: fetchFn };
    await sendAlerts([{ pagerduty: "R0UT1NG" }], DOWN, deps);
    await sendAlerts(
      [{ pagerduty: "R0UT1NG" }],
      { ...DOWN, kind: "recovered" },
      deps,
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://events.pagerduty.com/v2/enqueue",
      "https://events.pagerduty.com/v2/enqueue",
    ]);
    const [open, close] = calls.map((c) => JSON.parse(c.body));
    expect(open).toMatchObject({
      routing_key: "R0UT1NG",
      event_action: "trigger",
      dedup_key: "statoss:webhooks.cc:Redirector",
      payload: { severity: "critical", component: "Redirector" },
    });
    expect(close).toMatchObject({
      event_action: "resolve",
      dedup_key: "statoss:webhooks.cc:Redirector",
    });
  });

  it("creates on Opsgenie and closes by alias, in the region named", async () => {
    const { calls, fetchFn } = fakeFetch();
    const deps = { send: null, from: "", fetch: fetchFn };
    const to = [{ opsgenie: "KEY", region: "eu" as const }];
    await sendAlerts(to, { ...DOWN, kind: "went-slow" }, deps);
    await sendAlerts(to, { ...DOWN, kind: "back-to-normal" }, deps);
    expect(calls[0].url).toBe("https://api.eu.opsgenie.com/v2/alerts");
    expect(calls[0].headers.authorization).toBe("GenieKey KEY");
    expect(JSON.parse(calls[0].body)).toMatchObject({
      alias: "statoss:webhooks.cc:Redirector:slow",
      priority: "P3",
    });
    expect(calls[1].url).toBe(
      "https://api.eu.opsgenie.com/v2/alerts/statoss%3Awebhooks.cc%3ARedirector%3Aslow/close?identifierType=alias",
    );
  });

  it("posts plain text to ntfy with the title, priority and token as headers", async () => {
    const { calls, fetchFn } = fakeFetch();
    await sendAlerts(
      [{ ntfy: "https://ntfy.sh/mytopic", token: "tk_1" }],
      DOWN,
      { send: null, from: "", fetch: fetchFn },
    );
    expect(calls[0].url).toBe("https://ntfy.sh/mytopic");
    expect(calls[0].headers).toMatchObject({
      title: "webhooks.cc: Redirector is down",
      priority: "5",
      authorization: "Bearer tk_1",
      click: "https://status.webhooks.cc",
    });
    expect(calls[0].body).toContain("is failing");
  });
});

describe("retries", () => {
  function failing(times: number) {
    let n = 0;
    return vi.fn(async () =>
      n++ < times
        ? new Response("no", { status: 500 })
        : new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
  }

  it("tries a failed send again after one, five and fifteen minutes, then gives up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = failing(99);
    const queue: Array<[() => void, number]> = [];
    const deps = {
      send: null,
      from: "",
      fetch: fetchFn,
      schedule: (task: () => void, ms: number) => void queue.push([task, ms]),
    };
    const first = await sendAlerts(
      [{ slack: "https://hooks.slack.com/x" }],
      DOWN,
      deps,
    );
    expect(first).toEqual([
      { channel: "slack", ok: false, error: "hooks.slack.com answered 500" },
    ]);
    const waits: number[] = [];
    while (queue.length > 0) {
      const [task, ms] = queue.shift()!;
      waits.push(ms);
      task();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(waits).toEqual(RETRY_DELAYS_MS);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    vi.restoreAllMocks();
  });

  it("stops retrying once a send gets through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = failing(1);
    const queue: Array<() => void> = [];
    await sendAlerts([{ slack: "https://hooks.slack.com/x" }], DOWN, {
      send: null,
      from: "",
      fetch: fetchFn,
      schedule: (task) => void queue.push(task),
    });
    queue.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("drops a retry the monitor has overtaken", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = failing(99);
    const queue: Array<() => void> = [];
    await sendAlerts(
      [{ slack: "https://hooks.slack.com/x" }],
      DOWN,
      {
        send: null,
        from: "",
        fetch: fetchFn,
        schedule: (task) => void queue.push(task),
      },
      () => false,
    );
    queue.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe("notices", () => {
  const UPDATE: NoticeEvent = {
    kind: "incident-update",
    site: "webhooks.cc",
    pageUrl: "https://status.webhooks.cc",
    id: "2026-09-12-elevated-api-errors",
    title: "Elevated API errors",
    status: "Identified",
    body: "A connection limit was reached.",
    monitors: ["API"],
    at: NOW,
    now: NOW,
  };

  it("words an incident update and a maintenance window", () => {
    expect(describeNotice(UPDATE)).toEqual({
      subject: "webhooks.cc: Elevated API errors (Identified)",
      lines: [
        "A connection limit was reached.",
        "Affects: API",
        "Time: 2023-11-14 22:13 UTC",
      ],
    });
    expect(
      describeNotice({
        ...UPDATE,
        kind: "maintenance-scheduled",
        title: "Database upgrade",
        body: undefined,
        monitors: [],
        start: NOW,
        end: NOW + 3_600_000,
      }),
    ).toEqual({
      subject: "webhooks.cc: maintenance planned, Database upgrade",
      lines: ["Window: 2023-11-14 22:13 UTC to 2023-11-14 23:13 UTC"],
    });
  });

  it("goes to chat, mail and webhooks but pages nobody", async () => {
    const { calls, fetchFn } = fakeFetch();
    const results = await sendNotice(
      [
        { slack: "https://hooks.slack.com/x" },
        { pagerduty: "R0UT1NG" },
        { opsgenie: "KEY" },
        { webhook: "https://example.com/hook", secret: "s" },
      ],
      UPDATE,
      { send: null, from: "", fetch: fetchFn },
    );
    expect(results.map((r) => r.channel)).toEqual(["slack", "webhook"]);
    expect(calls[1].headers["x-statoss-event"]).toBe("incident-update");
    expect(JSON.parse(calls[1].body)).toMatchObject({
      event: "incident-update",
      id: "2026-09-12-elevated-api-errors",
      status: "Identified",
      monitors: ["API"],
    });
  });
});

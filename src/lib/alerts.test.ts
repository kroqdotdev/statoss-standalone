import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  alertMessage,
  buildAlertEmail,
  clip,
  describeAlert,
  formatDuration,
  RETRY_DELAYS_MS,
  describeNotice,
  describeVendor,
  headerText,
  refusalText,
  sendAlerts,
  sendNotice,
  sendVendorAlert,
  signWebhook,
  slackPayload,
  webhookPayload,
  type AlertEvent,
  type Mail,
  type NoticeEvent,
  type VendorEvent,
} from "./alerts";
import type { Destination } from "./config";

const NOW = 1_700_000_000_000;

const BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const USER_KEY = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const APP_TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
const WORKFLOW =
  "https://prod-12.westeurope.logic.azure.com:443/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=s1g";

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

describe("a monitor that goes down from slow", () => {
  it("closes its slow alert on a pager before opening the down one", async () => {
    const { calls, fetchFn } = fakeFetch();
    const deps = { send: null, from: "", fetch: fetchFn };
    const down = { ...DOWN, wasSlow: true };
    await sendAlerts([{ pagerduty: "R0UT1NG" }], down, deps);
    expect(calls.map((c) => JSON.parse(c.body))).toMatchObject([
      {
        event_action: "resolve",
        dedup_key: "statoss:webhooks.cc:Redirector:slow",
      },
      { event_action: "trigger", dedup_key: "statoss:webhooks.cc:Redirector" },
    ]);
    calls.length = 0;
    await sendAlerts([{ opsgenie: "KEY" }], down, deps);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.opsgenie.com/v2/alerts/statoss%3Awebhooks.cc%3ARedirector%3Aslow/close?identifierType=alias",
      "https://api.opsgenie.com/v2/alerts",
    ]);
    calls.length = 0;
    // A close that fails does not hold up the down alert.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        String(init?.body).includes('"resolve"')
          ? new Response("no", { status: 500 })
          : new Response("ok", { status: 202 }),
    ) as unknown as typeof fetch;
    const results = await sendAlerts([{ pagerduty: "R0UT1NG" }], down, {
      send: null,
      from: "",
      fetch: flaky,
    });
    expect(results).toEqual([{ channel: "pagerduty", ok: true }]);
    vi.restoreAllMocks();
    // Without slowness before it, only the down alert.
    await sendAlerts([{ pagerduty: "R0UT1NG" }], DOWN, deps);
    expect(calls).toHaveLength(1);
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

describe("vendor alerts", () => {
  const OUTAGE: VendorEvent = {
    kind: "vendor-changed",
    site: "shop",
    component: "GitHub Actions",
    pageUrl: "https://status.shop.example",
    vendor: {
      name: "GitHub",
      url: "https://www.githubstatus.com",
      part: "Actions",
      state: "major",
      incidents: [
        { name: "Delays in Actions runs", url: "https://stspg.io/abc" },
      ],
    },
    since: NOW - 3_600_000,
    stateSince: NOW,
    now: NOW,
  };

  it("say what the vendor reports, with its open incidents", () => {
    expect(describeVendor(OUTAGE)).toEqual({
      subject: "shop: GitHub Actions reports an outage",
      lines: [
        "GitHub Actions reports an outage. GitHub Actions on shop shows it.",
        "Delays in Actions runs: https://stspg.io/abc",
        "Time: 2023-11-14 22:13 UTC",
      ],
    });
    const whole = { ...OUTAGE.vendor, part: null };
    expect(
      describeVendor({ ...OUTAGE, vendor: { ...whole, state: "degraded" } })
        .subject,
    ).toBe("shop: GitHub reports trouble");
    expect(
      describeVendor({
        ...OUTAGE,
        vendor: { ...whole, state: "operational", incidents: [] },
      }).lines,
    ).toEqual([
      "GitHub reports it working again, after 1 h. GitHub Actions on shop shows it.",
      "Time: 2023-11-14 22:13 UTC",
    ]);
  });

  it("go to mail, chat, ntfy, Telegram, Pushover and Teams, never to a pager or a webhook", async () => {
    const { calls, fetchFn } = fakeFetch();
    const send = vi.fn<(mail: Mail) => Promise<unknown>>().mockResolvedValue(1);
    const results = await sendVendorAlert(
      [
        { email: "ops@example.com" },
        { slack: "https://hooks.slack.com/x" },
        { discord: "https://discord.com/api/webhooks/y" },
        { ntfy: "https://ntfy.sh/ops" },
        { telegram: "-1001234567890", token: BOT },
        { pushover: USER_KEY, token: APP_TOKEN, emergency: true },
        { teams: WORKFLOW },
        { webhook: "https://example.com/hook", secret: "s" },
        { pagerduty: "R0UT1NG" },
        { opsgenie: "KEY" },
      ],
      OUTAGE,
      { send, from: "status@example.com", fetch: fetchFn },
    );
    expect(results.map((r) => r.channel)).toEqual([
      "email",
      "slack",
      "discord",
      "ntfy",
      "telegram",
      "pushover",
      "teams",
    ]);
    expect(send.mock.calls[0][0].subject).toBe(
      "shop: GitHub Actions reports an outage",
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://hooks.slack.com/x",
      "https://discord.com/api/webhooks/y",
      "https://ntfy.sh/ops",
      `https://api.telegram.org/bot${BOT}/sendMessage`,
      "https://api.pushover.net/1/messages.json",
      WORKFLOW,
    ]);
    expect(calls[2].headers).toMatchObject({ priority: "3", tags: "cloud" });
    // A vendor's outage is not yours: normal priority, never an emergency.
    expect(new URLSearchParams(calls[4].body).get("priority")).toBe("0");
  });
});

describe("headerText", () => {
  it("keeps plain text, joins lines, and encodes the rest for ntfy", () => {
    expect(headerText("shop: API is down")).toBe("shop: API is down");
    expect(headerText("two\nlines")).toBe("two lines");
    const encoded = headerText("Café: 接口 is down");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe(
      "Café: 接口 is down",
    );
    // What fetch would have refused goes through as a header now.
    expect(() => new Headers({ title: encoded })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Telegram, Pushover and Teams, against a local server that answers as each
// API does, refusals included. fetch is the real one, with the services'
// hosts sent to the local server.

interface Received {
  path: string;
  type: string;
  body: string;
}

describe("Telegram, Pushover and Teams", () => {
  let server: Server;
  let base = "";
  const received: Received[] = [];

  /** Telegram's Bot API: one good token, and chats that each fail a way. */
  function telegram(path: string, body: string): [number, unknown] {
    const token = /^\/bot([^/]+)\/sendMessage$/.exec(path)?.[1];
    if (token === undefined)
      return [404, { ok: false, description: "Not Found" }];
    if (token !== BOT)
      return [401, { ok: false, error_code: 401, description: "Unauthorized" }];
    const chat = String(JSON.parse(body).chat_id);
    const fail = (
      code: number,
      description: string,
      more = {},
    ): [number, unknown] => [
      code,
      { ok: false, error_code: code, description, ...more },
    ];
    switch (chat) {
      case "-404":
        return fail(400, "Bad Request: chat not found");
      case "-403":
        return fail(403, "Forbidden: bot was blocked by the user");
      case "-77":
        return fail(
          400,
          "Bad Request: group chat was upgraded to a supergroup chat",
          { parameters: { migrate_to_chat_id: -1001234567890 } },
        );
      case "-429":
        return fail(429, "Too Many Requests: retry after 5", {
          parameters: { retry_after: 5 },
        });
      case "-500":
        return fail(500, "Internal Server Error");
      default:
        return [200, { ok: true, result: { message_id: 1 } }];
    }
  }

  /** Pushover's messages API, which takes form fields. */
  function pushover(body: string): [number, unknown] {
    const form = new URLSearchParams(body);
    if (form.get("token") !== APP_TOKEN)
      return [
        400,
        {
          token: "invalid",
          errors: ["application token is invalid"],
          status: 0,
        },
      ];
    if (form.get("user") !== USER_KEY)
      return [
        400,
        {
          user: "invalid",
          errors: [
            "user identifier is not a valid user, group, or subscribed user key",
          ],
          status: 0,
        },
      ];
    return [200, { status: 1, request: "r1" }];
  }

  /** A Teams workflow: one that runs, one deleted, one busy, one down. */
  function teams(path: string): [number, unknown] {
    if (path.includes("/workflows/gone/"))
      return [
        404,
        {
          error: {
            code: "WorkflowNotFound",
            message: "The workflow 'gone' could not be found.",
          },
        },
      ];
    if (path.includes("/workflows/busy/"))
      return [
        429,
        {
          error: {
            code: "WorkflowRequestsThrottled",
            message: "Rate limit is exceeded.",
          },
        },
      ];
    if (path.includes("/workflows/down/"))
      return [502, "<html><body>Bad Gateway</body></html>"];
    return [202, ""];
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        received.push({ path, type: req.headers["content-type"] ?? "", body });
        const [status, out] = path.startsWith("/bot")
          ? telegram(path, body)
          : path === "/1/messages.json"
            ? pushover(body)
            : teams(path);
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(typeof out === "string" ? out : JSON.stringify(out));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    received.length = 0;
    vi.restoreAllMocks();
  });

  const viaLocal = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return fetch(`${base}${url.pathname}${url.search}`, init);
  }) as typeof fetch;

  function deps(queue?: Array<() => void>) {
    return {
      send: null,
      from: "",
      fetch: viaLocal,
      ...(queue
        ? { schedule: (task: () => void) => void queue.push(task) }
        : {}),
    };
  }

  const TO: Destination[] = [
    { telegram: "-1001234567890", token: BOT },
    { pushover: USER_KEY, token: APP_TOKEN },
    { teams: WORKFLOW },
  ];

  it("sends Telegram the same words as the other channels, escaped, with the page", async () => {
    const event = {
      ...DOWN,
      monitor: "API <v2> & co",
      error: 'HTTP 503 "busy"',
    };
    const results = await sendAlerts([TO[0]], event, deps());
    expect(results).toEqual([{ channel: "telegram", ok: true }]);
    expect(received[0].path).toBe(`/bot${BOT}/sendMessage`);
    expect(received[0].type).toBe("application/json");
    const { subject, lines } = describeAlert(event);
    const sent = JSON.parse(received[0].body);
    expect(sent).toEqual({
      chat_id: "-1001234567890",
      text: [
        "<b>webhooks.cc: API &lt;v2&gt; &amp; co is down</b>",
        "API &lt;v2&gt; &amp; co (https://go.webhooks.cc) is failing.",
        "Error: HTTP 503 &quot;busy&quot;",
        "Time: 2023-11-14 22:13 UTC",
        "Status page: https://status.webhooks.cc",
      ].join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    expect(subject).toBe("webhooks.cc: API <v2> & co is down");
    expect(lines).toHaveLength(3);
  });

  it("sends Pushover a down alert at priority 1, and the rest at 0", async () => {
    const kinds: AlertEvent["kind"][] = [
      "went-down",
      "still-down",
      "went-slow",
      "back-to-normal",
      "recovered",
    ];
    for (const kind of kinds)
      await sendAlerts(
        [TO[1]],
        { ...DOWN, kind, downSince: NOW - 60_000 },
        deps(),
      );
    const forms = received.map((r) => new URLSearchParams(r.body));
    expect(received[0].type).toBe("application/x-www-form-urlencoded");
    expect(forms.map((f) => f.get("priority"))).toEqual([
      "1",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(Object.fromEntries(forms[0])).toEqual({
      token: APP_TOKEN,
      user: USER_KEY,
      title: "webhooks.cc: Redirector is down",
      message: [
        "Redirector (https://go.webhooks.cc) is failing.",
        "Error: timeout",
        "Time: 2023-11-14 22:13 UTC",
      ].join("\n"),
      url: "https://status.webhooks.cc",
      url_title: "Status page",
      priority: "1",
    });
    expect(forms.some((f) => f.has("retry") || f.has("expire"))).toBe(false);
  });

  it("sends Pushover a down alert as an emergency when asked, and only that", async () => {
    const to = [{ ...TO[1], emergency: true }];
    for (const kind of ["went-down", "still-down", "recovered"] as const)
      await sendAlerts(to, { ...DOWN, kind, downSince: NOW - 60_000 }, deps());
    const forms = received.map((r) =>
      Object.fromEntries(new URLSearchParams(r.body)),
    );
    expect(forms[0]).toMatchObject({
      priority: "2",
      retry: "60",
      expire: "10800",
    });
    expect(forms[1].priority).toBe("1");
    expect(forms[2].priority).toBe("0");
    expect(forms.slice(1).some((f) => "retry" in f || "expire" in f)).toBe(
      false,
    );
  });

  it("sends Teams one Adaptive Card with the words as text runs and the page as a button", async () => {
    const results = await sendAlerts([TO[2]], DOWN, deps());
    expect(results).toEqual([{ channel: "teams", ok: true }]);
    expect(received[0].path).toBe(
      "/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=s1g",
    );
    const sent = JSON.parse(received[0].body);
    expect(sent.type).toBe("message");
    expect(sent.attachments).toHaveLength(1);
    const card = sent.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.type).toBe("AdaptiveCard");
    expect(
      card.content.body.map(
        (b: { inlines: Array<{ text: string }> }) => b.inlines[0].text,
      ),
    ).toEqual([
      "webhooks.cc: Redirector is down",
      "Redirector (https://go.webhooks.cc) is failing.",
      "Error: timeout",
      "Time: 2023-11-14 22:13 UTC",
    ]);
    expect(card.content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Status page",
        url: "https://status.webhooks.cc",
      },
    ]);
  });

  it("get incident updates and maintenance notices, as Slack and Discord do", async () => {
    const notice: NoticeEvent = {
      kind: "maintenance-started",
      site: "webhooks.cc",
      pageUrl: "https://status.webhooks.cc",
      id: "db",
      title: "Database upgrade",
      monitors: [],
      start: NOW,
      end: NOW + 3_600_000,
      at: NOW,
      now: NOW,
    };
    const results = await sendNotice(TO, notice, deps());
    expect(results.map((r) => [r.channel, r.ok])).toEqual([
      ["telegram", true],
      ["pushover", true],
      ["teams", true],
    ]);
    expect(JSON.parse(received[0].body).text).toContain(
      "maintenance started, Database upgrade",
    );
    expect(new URLSearchParams(received[1].body).get("priority")).toBe("0");
  });

  it("keeps a long update inside Telegram's and Pushover's limits", async () => {
    const long = "word ".repeat(2000);
    await sendNotice(
      TO.slice(0, 2),
      {
        kind: "incident-update",
        site: "webhooks.cc",
        pageUrl: "https://status.webhooks.cc",
        id: "x",
        title: "Long",
        status: "Identified",
        body: long,
        monitors: [],
        at: NOW,
        now: NOW,
      },
      deps(),
    );
    const text: string = JSON.parse(received[0].body).text;
    const shown = text.replace(/<\/?b>/g, "").replace(/&amp;/g, "&");
    expect(shown.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("…");
    expect(text.endsWith("Status page: https://status.webhooks.cc")).toBe(true);
    const message = new URLSearchParams(received[1].body).get("message") ?? "";
    expect(message.length).toBe(1024);
    expect(message.endsWith("…")).toBe(true);
  });

  it("stays inside the limits when the page's address is very long", async () => {
    const pageUrl = `https://status.example.com/${"p".repeat(5000)}`;
    await sendAlerts(TO.slice(0, 2), { ...DOWN, pageUrl }, deps());
    const text: string = JSON.parse(received[0].body).text;
    expect(text.replace(/<\/?b>/g, "").length).toBeLessThanOrEqual(4096);
    expect(text).toContain("is failing.");
    const form = new URLSearchParams(received[1].body);
    expect(form.has("url")).toBe(false);
    expect(form.has("url_title")).toBe(false);
  });

  it.each([
    [
      { telegram: "-404", token: BOT },
      "api.telegram.org answered 400: Bad Request: chat not found. Check the chat id, and that the bot is in the chat and may post there.",
    ],
    [
      { telegram: "-403", token: BOT },
      "api.telegram.org answered 403: Forbidden: bot was blocked by the user. Add the bot to the chat again, or unblock it.",
    ],
    [
      {
        telegram: "-1001234567890",
        token: "123456789:wrongwrongwrongwrongwrong",
      },
      "api.telegram.org answered 401: Unauthorized. Check the bot token.",
    ],
    [
      { telegram: "-77", token: BOT },
      "api.telegram.org answered 400: Bad Request: group chat was upgraded to a supergroup chat; the chat id is now -1001234567890. Check the chat id, and that the bot is in the chat and may post there.",
    ],
    [
      { pushover: "x".repeat(30), token: APP_TOKEN },
      "api.pushover.net answered 400: user identifier is not a valid user, group, or subscribed user key. Check the user key and the application token.",
    ],
    [
      { pushover: USER_KEY, token: "y".repeat(30) },
      "api.pushover.net answered 400: application token is invalid. Check the user key and the application token.",
    ],
    [
      { teams: WORKFLOW.replace("0a1b2c", "gone") },
      "prod-12.westeurope.logic.azure.com answered 404: The workflow 'gone' could not be found. Check the workflow URL, and that the workflow is turned on.",
    ],
  ] as Array<[Destination, string]>)(
    "does not retry a setup that is wrong, and says why: %o",
    async (to, reason) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const queue: Array<() => void> = [];
      const [result] = await sendAlerts([to], DOWN, deps(queue));
      expect(result).toMatchObject({ ok: false, error: reason });
      expect(queue).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(
          `refused "webhooks.cc: Redirector is down", not trying again: ${reason}`,
        ),
      );
      // The bot token is in Telegram's address, and never in the log.
      expect(errors.mock.calls.flat().join(" ")).not.toContain(
        BOT.split(":")[1],
      );
    },
  );

  it.each([
    [
      { telegram: "-429", token: BOT },
      "api.telegram.org answered 429: Too Many Requests: retry after 5",
    ],
    [
      { telegram: "-500", token: BOT },
      "api.telegram.org answered 500: Internal Server Error",
    ],
    [
      { teams: WORKFLOW.replace("0a1b2c", "busy") },
      "prod-12.westeurope.logic.azure.com answered 429: Rate limit is exceeded.",
    ],
    [
      { teams: WORKFLOW.replace("0a1b2c", "down") },
      "prod-12.westeurope.logic.azure.com answered 502",
    ],
  ] as Array<[Destination, string]>)(
    "retries too many requests and server errors: %o",
    async (to, reason) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const queue: Array<() => void> = [];
      const [result] = await sendAlerts([to], DOWN, deps(queue));
      expect(result).toMatchObject({ ok: false, error: reason });
      expect(queue).toHaveLength(1);
    },
  );

  it("stops retrying when a retry finds the setup wrong", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue: Array<() => void> = [];
    let n = 0;
    // A server error first, then the bot is blocked.
    const flaky = ((input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      body.chat_id = n++ === 0 ? "-500" : "-403";
      return viaLocal(input, { ...init, body: JSON.stringify(body) });
    }) as typeof fetch;
    await sendAlerts([TO[0]], DOWN, { ...deps(queue), fetch: flaky });
    expect(queue).toHaveLength(1);
    queue.shift()!();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue).toHaveLength(0);
  });
});

describe("refusalText", () => {
  it("reads each API's reason, and no HTML page", () => {
    expect(refusalText('{"ok":false,"description":"Unauthorized"}')).toBe(
      "Unauthorized",
    );
    expect(refusalText('{"errors":["a","b"],"status":0}')).toBe("a; b");
    expect(refusalText('{"error":{"message":"Gone."}}')).toBe("Gone.");
    expect(refusalText("Bad payload received")).toBe("Bad payload received");
    expect(refusalText("<html><body>502</body></html>")).toBe("");
    expect(refusalText("")).toBe("");
    expect(refusalText("null")).toBe("");
  });
});

describe("clip", () => {
  it("keeps short text and cuts long text without halving a character", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abcdef", 1)).toBe("…");
    expect(clip("abcdef", 0)).toBe("");
    expect(clip("abcdef", -5)).toBe("");
    const cut = clip(`ab${"😀".repeat(3)}`, 4);
    expect(cut).toBe("ab…");
    expect(alertMessage(DOWN).pushover).toEqual({
      priority: 1,
      emergency: true,
    });
  });
});

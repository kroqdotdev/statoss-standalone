import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAlertEmail,
  describeAlert,
  formatDuration,
  sendAlerts,
  signWebhook,
  slackPayload,
  webhookPayload,
  type AlertEvent,
  type Mail,
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

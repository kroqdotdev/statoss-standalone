import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { Destination, SmtpConfig } from "./config";
import { formatCount, formatDuration, formatUtcStamp } from "./format";

export { formatDuration };

export type AlertKind =
  "went-down" | "recovered" | "went-slow" | "back-to-normal" | "still-down";

export interface AlertEvent {
  kind: AlertKind;
  site: string;
  monitor: string;
  url: string;
  /** Where the public page lives, so the message can link to it. */
  pageUrl: string;
  error?: string | null;
  /** When the outage began, for recoveries and repeat notices. */
  downSince?: number;
  /** The response time that tripped the slow threshold, and the threshold. */
  latencyMs?: number | null;
  thresholdMs?: number | null;
  now: number;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<unknown>;

/** The words of an alert, shared by every channel. */
export function describeAlert(event: AlertEvent): {
  subject: string;
  lines: string[];
} {
  const time = `Time: ${formatUtcStamp(event.now)}`;
  const where = `${event.monitor} (${event.url})`;
  const downFor =
    event.downSince !== undefined
      ? formatDuration(event.now - event.downSince)
      : "unknown";
  switch (event.kind) {
    case "went-down":
      return {
        subject: `${event.site}: ${event.monitor} is down`,
        lines: [
          `${where} is failing.`,
          `Error: ${event.error ?? "unknown"}`,
          time,
        ],
      };
    case "still-down":
      return {
        subject: `${event.site}: ${event.monitor} is still down`,
        lines: [
          `${where} has been down for ${downFor}.`,
          `Error: ${event.error ?? "unknown"}`,
          time,
        ],
      };
    case "recovered":
      return {
        subject: `${event.site}: ${event.monitor} recovered`,
        lines: [`${where} is back up.`, `Downtime: ${downFor}`, time],
      };
    case "went-slow":
      return {
        subject: `${event.site}: ${event.monitor} is slow`,
        lines: [
          `${where} is responding, but slowly.`,
          `Response time: ${formatCount(event.latencyMs ?? 0)} ms, over the ${formatCount(event.thresholdMs ?? 0)} ms threshold`,
          time,
        ],
      };
    case "back-to-normal":
      return {
        subject: `${event.site}: ${event.monitor} is back to normal speed`,
        lines: [
          `${where} is responding at normal speed again.`,
          `Slow for: ${downFor}`,
          time,
        ],
      };
  }
}

export function buildAlertEmail(event: AlertEvent): {
  subject: string;
  text: string;
} {
  const { subject, lines } = describeAlert(event);
  return {
    subject,
    text: `${lines.join("\n")}\n\nStatus page: ${event.pageUrl}\n`,
  };
}

/** Slack's incoming webhooks take a text field with mrkdwn. */
export function slackPayload(event: AlertEvent): { text: string } {
  const { subject, lines } = describeAlert(event);
  return {
    text: [`*${subject}*`, ...lines, `<${event.pageUrl}|Status page>`].join(
      "\n",
    ),
  };
}

/** Discord webhooks take a content field with markdown. */
export function discordPayload(event: AlertEvent): { content: string } {
  const { subject, lines } = describeAlert(event);
  return {
    content: [`**${subject}**`, ...lines, `Status page: ${event.pageUrl}`].join(
      "\n",
    ),
  };
}

/**
 * The generic webhook body: one flat object, stable field names.
 * `checkpoint` repeats `monitor` under its name before 0.2.
 */
export function webhookPayload(event: AlertEvent): Record<string, unknown> {
  return {
    event: event.kind,
    site: event.site,
    monitor: event.monitor,
    checkpoint: event.monitor,
    url: event.url,
    pageUrl: event.pageUrl,
    error: event.error ?? null,
    downSince: event.downSince ?? null,
    latencyMs: event.latencyMs ?? null,
    thresholdMs: event.thresholdMs ?? null,
    at: event.now,
  };
}

/** "sha256=<hex>" over the raw body, for the X-StatOSS-Signature header. */
export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function smtpSend(smtp: SmtpConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    // Never fall back to a plain-text session on submission ports.
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: process.env.SMTP_PASS },
  });
  return (mail) => transport.sendMail(mail);
}

export interface AlertDeps {
  /** Null when no SMTP is configured; email destinations are then skipped. */
  send: SendMail | null;
  from: string;
  fetch: typeof fetch;
}

async function post(
  fetchFn: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  void res.body?.cancel().catch(() => {});
}

export type ChannelName = "email" | "slack" | "discord" | "webhook";

export interface AlertResult {
  channel: ChannelName;
  ok: boolean;
  error?: string;
}

/**
 * Delivers one alert to every destination. Destinations fail on their own:
 * a dead Slack webhook does not stop the email. Never throws.
 */
export async function sendAlerts(
  destinations: Destination[],
  event: AlertEvent,
  deps: AlertDeps,
): Promise<AlertResult[]> {
  const { subject } = describeAlert(event);
  const tasks: Array<[ChannelName, Promise<void>]> = [];
  for (const d of destinations) {
    if ("email" in d) {
      if (deps.send === null) continue;
      const send = deps.send;
      tasks.push([
        "email",
        send({ from: deps.from, to: d.email, ...buildAlertEmail(event) }).then(
          () => undefined,
        ),
      ]);
    } else if ("slack" in d) {
      tasks.push([
        "slack",
        post(deps.fetch, d.slack, JSON.stringify(slackPayload(event)), {}),
      ]);
    } else if ("discord" in d) {
      tasks.push([
        "discord",
        post(deps.fetch, d.discord, JSON.stringify(discordPayload(event)), {}),
      ]);
    } else {
      const body = JSON.stringify(webhookPayload(event));
      tasks.push([
        "webhook",
        post(deps.fetch, d.webhook, body, {
          "x-statoss-event": event.kind,
          "x-statoss-signature": signWebhook(d.secret, body),
        }),
      ]);
    }
  }
  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  return results.map((result, i) => {
    const name = tasks[i][0];
    if (result.status === "fulfilled") {
      console.log(`[alerts] ${name}: sent "${subject}"`);
      return { channel: name, ok: true };
    }
    console.error(`[alerts] ${name} failed for "${subject}"`, result.reason);
    const reason = result.reason;
    return {
      channel: name,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  });
}

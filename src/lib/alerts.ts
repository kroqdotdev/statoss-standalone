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
  /** went-down: the time of the first failed check of the outage. */
  failingSince?: number | null;
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
          ...(event.failingSince
            ? [`Failing since: ${formatUtcStamp(event.failingSince)}`]
            : []),
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
    failingSince: event.failingSince ?? null,
    latencyMs: event.latencyMs ?? null,
    thresholdMs: event.thresholdMs ?? null,
    at: event.now,
  };
}

/** "sha256=<hex>" over the raw body, for the X-StatOSS-Signature header. */
export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Notices: what a person wrote, as opposed to what a check found. An update
// on an incident file, and a maintenance window planned, starting and over.

export type NoticeKind =
  | "incident-update"
  | "maintenance-scheduled"
  | "maintenance-started"
  | "maintenance-ended";

export interface NoticeEvent {
  kind: NoticeKind;
  site: string;
  pageUrl: string;
  /** The incident's or window's id and title. */
  id: string;
  title: string;
  /** incident-update: the update's status word, "Investigating". */
  status?: string;
  /** The update's text, or the window's notes. */
  body?: string;
  /** The monitors it names. Empty means the whole site. */
  monitors: string[];
  /** Maintenance: the window. */
  start?: number;
  end?: number;
  /** The update's own time, or when the window reached this stage. */
  at: number;
  now: number;
}

export function describeNotice(event: NoticeEvent): {
  subject: string;
  lines: string[];
} {
  const scope =
    event.monitors.length > 0 ? [`Affects: ${event.monitors.join(", ")}`] : [];
  const window =
    event.start !== undefined && event.end !== undefined
      ? [
          `Window: ${formatUtcStamp(event.start)} to ${formatUtcStamp(event.end)}`,
        ]
      : [];
  const body = event.body ? [event.body] : [];
  switch (event.kind) {
    case "incident-update":
      return {
        subject: `${event.site}: ${event.title} (${event.status ?? "Update"})`,
        lines: [...body, ...scope, `Time: ${formatUtcStamp(event.at)}`],
      };
    case "maintenance-scheduled":
      return {
        subject: `${event.site}: maintenance planned, ${event.title}`,
        lines: [...window, ...body, ...scope],
      };
    case "maintenance-started":
      return {
        subject: `${event.site}: maintenance started, ${event.title}`,
        lines: [...window, ...body, ...scope],
      };
    case "maintenance-ended":
      return {
        subject: `${event.site}: maintenance is over, ${event.title}`,
        lines: [...window, ...scope],
      };
  }
}

export function noticeWebhookPayload(
  event: NoticeEvent,
): Record<string, unknown> {
  return {
    event: event.kind,
    site: event.site,
    id: event.id,
    title: event.title,
    status: event.status ?? null,
    body: event.body ?? null,
    monitors: event.monitors,
    start: event.start ?? null,
    end: event.end ?? null,
    pageUrl: event.pageUrl,
    at: event.at,
  };
}

// ---------------------------------------------------------------------------
// One message, whatever it is about, in the shape every channel can send.

export interface Message {
  /** The X-StatOSS-Event header and the webhook's `event`. */
  event: string;
  subject: string;
  lines: string[];
  pageUrl: string;
  webhook: Record<string, unknown>;
  ntfy: { priority: string; tags: string };
  /**
   * What PagerDuty and Opsgenie do with it: open an alert, close the one
   * opened under the same key, or nothing. Notices page nobody.
   */
  pager: {
    action: "trigger" | "resolve";
    key: string;
    severity: "critical" | "warning";
    source: string;
    component: string;
    group: string;
    at: number;
  } | null;
}

const NTFY: Record<AlertKind | NoticeKind, { priority: string; tags: string }> =
  {
    "went-down": { priority: "5", tags: "rotating_light" },
    "still-down": { priority: "4", tags: "rotating_light" },
    "went-slow": { priority: "4", tags: "turtle" },
    recovered: { priority: "3", tags: "white_check_mark" },
    "back-to-normal": { priority: "3", tags: "white_check_mark" },
    "incident-update": { priority: "3", tags: "memo" },
    "maintenance-scheduled": { priority: "2", tags: "wrench" },
    "maintenance-started": { priority: "3", tags: "wrench" },
    "maintenance-ended": { priority: "2", tags: "white_check_mark" },
  };

export function alertMessage(event: AlertEvent): Message {
  const { subject, lines } = describeAlert(event);
  // Down and slow are two alerts on a pager, each closed by its own end.
  const slowness =
    event.kind === "went-slow" || event.kind === "back-to-normal";
  return {
    event: event.kind,
    subject,
    lines,
    pageUrl: event.pageUrl,
    webhook: webhookPayload(event),
    ntfy: NTFY[event.kind],
    pager: {
      action:
        event.kind === "recovered" || event.kind === "back-to-normal"
          ? "resolve"
          : "trigger",
      key: `statoss:${event.site}:${event.monitor}${slowness ? ":slow" : ""}`,
      severity: slowness ? "warning" : "critical",
      source: event.url || event.site,
      component: event.monitor,
      group: event.site,
      at: event.now,
    },
  };
}

export function noticeMessage(event: NoticeEvent): Message {
  const { subject, lines } = describeNotice(event);
  return {
    event: event.kind,
    subject,
    lines,
    pageUrl: event.pageUrl,
    webhook: noticeWebhookPayload(event),
    ntfy: NTFY[event.kind],
    pager: null,
  };
}

/** PagerDuty Events API v2: one trigger per outage, resolved by the same key. */
export function pagerdutyPayload(
  message: Message,
  routingKey: string,
): Record<string, unknown> {
  const pager = message.pager;
  return {
    routing_key: routingKey,
    event_action: pager?.action,
    dedup_key: pager?.key,
    payload: {
      summary: message.subject,
      source: pager?.source,
      severity: pager?.severity,
      timestamp: new Date(pager?.at ?? 0).toISOString(),
      component: pager?.component,
      group: pager?.group,
      custom_details: { detail: message.lines.join("\n"), ...message.webhook },
    },
    links: [{ href: message.pageUrl, text: "Status page" }],
  };
}

export function opsgenieBase(eu: boolean): string {
  return eu ? "https://api.eu.opsgenie.com" : "https://api.opsgenie.com";
}

/** Opsgenie alerts API: create with an alias, close by the same alias. */
export function opsgeniePayload(message: Message): Record<string, unknown> {
  return {
    message: message.subject,
    alias: message.pager?.key,
    description: `${message.lines.join("\n")}\n${message.pageUrl}`,
    priority: message.pager?.severity === "warning" ? "P3" : "P1",
    source: "StatOSS",
    entity: message.pager?.group,
    details: message.webhook,
  };
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
  /**
   * Runs a retry later. Left out, a send that fails is not tried again,
   * which is what the tests want.
   */
  schedule?: (task: () => void, delayMs: number) => void;
}

/** A send that did not get through is tried again after these waits. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

async function post(
  fetchFn: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  contentType = "application/json",
): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  void res.body?.cancel().catch(() => {});
}

export type ChannelName =
  "email" | "slack" | "discord" | "webhook" | "pagerduty" | "opsgenie" | "ntfy";

export interface AlertResult {
  channel: ChannelName;
  ok: boolean;
  error?: string;
}

const PAGERDUTY_EVENTS = "https://events.pagerduty.com/v2/enqueue";

export function channelOf(d: Destination): ChannelName {
  if ("email" in d) return "email";
  if ("slack" in d) return "slack";
  if ("discord" in d) return "discord";
  if ("pagerduty" in d) return "pagerduty";
  if ("opsgenie" in d) return "opsgenie";
  if ("ntfy" in d) return "ntfy";
  return "webhook";
}

/**
 * Sends one message to one destination. Null when the destination has no
 * use for it: an email without SMTP, a notice to a pager.
 */
function deliver(
  d: Destination,
  message: Message,
  deps: AlertDeps,
): Promise<void> | null {
  const text = message.lines.join("\n");
  if ("email" in d) {
    if (deps.send === null) return null;
    return deps
      .send({
        from: deps.from,
        to: d.email,
        subject: message.subject,
        text: `${text}\n\nStatus page: ${message.pageUrl}\n`,
      })
      .then(() => undefined);
  }
  if ("slack" in d)
    return post(
      deps.fetch,
      d.slack,
      JSON.stringify({
        text: [
          `*${message.subject}*`,
          ...message.lines,
          `<${message.pageUrl}|Status page>`,
        ].join("\n"),
      }),
      {},
    );
  if ("discord" in d)
    return post(
      deps.fetch,
      d.discord,
      JSON.stringify({
        content: [
          `**${message.subject}**`,
          ...message.lines,
          `Status page: ${message.pageUrl}`,
        ].join("\n"),
      }),
      {},
    );
  if ("pagerduty" in d) {
    if (message.pager === null) return null;
    return post(
      deps.fetch,
      PAGERDUTY_EVENTS,
      JSON.stringify(pagerdutyPayload(message, d.pagerduty)),
      {},
    );
  }
  if ("opsgenie" in d) {
    if (message.pager === null) return null;
    const base = opsgenieBase(d.region === "eu");
    const headers = { authorization: `GenieKey ${d.opsgenie}` };
    return message.pager.action === "trigger"
      ? post(
          deps.fetch,
          `${base}/v2/alerts`,
          JSON.stringify(opsgeniePayload(message)),
          headers,
        )
      : post(
          deps.fetch,
          `${base}/v2/alerts/${encodeURIComponent(message.pager.key)}/close?identifierType=alias`,
          JSON.stringify({ source: "StatOSS", note: message.subject }),
          headers,
        );
  }
  if ("ntfy" in d)
    return post(
      deps.fetch,
      d.ntfy,
      text,
      {
        title: message.subject,
        priority: message.ntfy.priority,
        tags: message.ntfy.tags,
        click: message.pageUrl,
        ...(d.token ? { authorization: `Bearer ${d.token}` } : {}),
      },
      "text/plain; charset=utf-8",
    );
  const body = JSON.stringify(message.webhook);
  return post(deps.fetch, d.webhook, body, {
    "x-statoss-event": message.event,
    "x-statoss-signature": signWebhook(d.secret, body),
  });
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tries a failed send again after one, five and fifteen minutes, as long
 * as `stillHolds` says the message is still true: a "went down" for a
 * monitor that has recovered since is dropped, not delivered late. Every
 * attempt is logged, which is the delivery record.
 */
function retryLater(
  d: Destination,
  message: Message,
  deps: AlertDeps,
  stillHolds: () => boolean,
  attempt: number,
): void {
  const channel = channelOf(d);
  const delay = RETRY_DELAYS_MS[attempt];
  if (deps.schedule === undefined || delay === undefined) {
    if (deps.schedule !== undefined)
      console.error(
        `[alerts] ${channel}: gave up on "${message.subject}" after ${attempt + 1} attempts`,
      );
    return;
  }
  console.warn(
    `[alerts] ${channel}: trying "${message.subject}" again in ${delay / 60_000} min`,
  );
  deps.schedule(() => {
    if (!stillHolds()) {
      console.log(
        `[alerts] ${channel}: dropped "${message.subject}", no longer true`,
      );
      return;
    }
    const task = deliver(d, message, deps);
    if (task === null) return;
    task.then(
      () =>
        console.log(
          `[alerts] ${channel}: sent "${message.subject}" on attempt ${attempt + 2}`,
        ),
      (err: unknown) => {
        console.error(
          `[alerts] ${channel} failed for "${message.subject}": ${reasonOf(err)}`,
        );
        retryLater(d, message, deps, stillHolds, attempt + 1);
      },
    );
  }, delay);
}

/**
 * Delivers one message to every destination. Destinations fail on their
 * own: a dead Slack webhook does not stop the email. Never throws. The
 * results are those of the first attempt; retries run in the background.
 */
export async function sendMessage(
  destinations: Destination[],
  message: Message,
  deps: AlertDeps,
  stillHolds: () => boolean = () => true,
): Promise<AlertResult[]> {
  const tasks: Array<[Destination, Promise<void>]> = [];
  for (const d of destinations) {
    const task = deliver(d, message, deps);
    if (task !== null) tasks.push([d, task]);
  }
  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  return results.map((result, i) => {
    const d = tasks[i][0];
    const channel = channelOf(d);
    if (result.status === "fulfilled") {
      console.log(`[alerts] ${channel}: sent "${message.subject}"`);
      return { channel, ok: true };
    }
    const error = reasonOf(result.reason);
    console.error(
      `[alerts] ${channel} failed for "${message.subject}": ${error}`,
    );
    retryLater(d, message, deps, stillHolds, 0);
    return { channel, ok: false, error };
  });
}

export function sendAlerts(
  destinations: Destination[],
  event: AlertEvent,
  deps: AlertDeps,
  stillHolds?: () => boolean,
): Promise<AlertResult[]> {
  return sendMessage(destinations, alertMessage(event), deps, stillHolds);
}

export function sendNotice(
  destinations: Destination[],
  event: NoticeEvent,
  deps: AlertDeps,
): Promise<AlertResult[]> {
  return sendMessage(destinations, noticeMessage(event), deps);
}

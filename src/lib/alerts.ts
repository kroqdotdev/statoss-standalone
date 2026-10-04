import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { ComponentState, Destination, SmtpConfig } from "./config";
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
  /** went-down: the monitor was slow until now, and its slow alert is still open on a pager. */
  wasSlow?: boolean;
  /** When the state the alert is about began, so a late retry can tell it is still that one. */
  stateSince?: number;
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
// Vendors: a component that follows a vendor's status page moved with it.

export type VendorKind = "vendor-changed";

export interface VendorEvent {
  kind: VendorKind;
  site: string;
  /** The component on the page that follows the vendor. */
  component: string;
  pageUrl: string;
  vendor: {
    /** What the vendor is called. */
    name: string;
    /** The vendor's page. */
    url: string;
    /** The part of it the component follows, or null for the whole page. */
    part: string | null;
    /** What the vendor says now. */
    state: ComponentState;
    /** Its open incidents. */
    incidents: Array<{ name: string; url: string }>;
  };
  /** When the state it left began. */
  since: number;
  /** When this state began, so a late retry can tell it is still this one. */
  stateSince: number;
  now: number;
}

export function describeVendor(event: VendorEvent): {
  subject: string;
  lines: string[];
} {
  const v = event.vendor;
  const what = v.part ? `${v.name} ${v.part}` : v.name;
  const said =
    v.state === "major"
      ? "reports an outage"
      : v.state === "operational"
        ? "reports it working again"
        : "reports trouble";
  const shows = `${event.component} on ${event.site} shows it.`;
  return {
    subject: `${event.site}: ${what} ${said}`,
    lines: [
      v.state === "operational"
        ? `${what} ${said}, after ${formatDuration(event.now - event.since)}. ${shows}`
        : `${what} ${said}. ${shows}`,
      ...v.incidents.slice(0, 3).map((i) => `${i.name}: ${i.url}`),
      `Time: ${formatUtcStamp(event.now)}`,
    ],
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
  /** The webhook's body, or null for a message no webhook gets. */
  webhook: Record<string, unknown> | null;
  ntfy: { priority: string; tags: string };
  /**
   * Pushover's priority: 1 for a monitor that is down, which sounds through
   * quiet hours, and 0 for the rest. `emergency` marks the alert that a
   * destination with emergency: true gets at 2, repeated until someone
   * acknowledges it.
   */
  pushover: { priority: 0 | 1; emergency: boolean };
  /**
   * What PagerDuty and Opsgenie do with it: open an alert, close the one
   * opened under the same key, or nothing. Notices page nobody.
   */
  pager: {
    action: "trigger" | "resolve";
    key: string;
    /** Other alerts this one closes first, by key. */
    closes?: string[];
    severity: "critical" | "warning";
    source: string;
    component: string;
    group: string;
    at: number;
  } | null;
}

const NTFY: Record<
  AlertKind | NoticeKind | VendorKind,
  { priority: string; tags: string }
> = {
  "went-down": { priority: "5", tags: "rotating_light" },
  "still-down": { priority: "4", tags: "rotating_light" },
  "went-slow": { priority: "4", tags: "turtle" },
  recovered: { priority: "3", tags: "white_check_mark" },
  "back-to-normal": { priority: "3", tags: "white_check_mark" },
  "incident-update": { priority: "3", tags: "memo" },
  "maintenance-scheduled": { priority: "2", tags: "wrench" },
  "maintenance-started": { priority: "3", tags: "wrench" },
  "maintenance-ended": { priority: "2", tags: "white_check_mark" },
  "vendor-changed": { priority: "3", tags: "cloud" },
};

const QUIET = { priority: 0, emergency: false } as const;

/** A monitor going down is urgent; its repeat notice too, but it pages once. */
function pushoverOf(kind: AlertKind): Message["pushover"] {
  if (kind === "went-down") return { priority: 1, emergency: true };
  if (kind === "still-down") return { priority: 1, emergency: false };
  return QUIET;
}

export function alertMessage(event: AlertEvent): Message {
  const { subject, lines } = describeAlert(event);
  // Down and slow are two alerts on a pager, each closed by its own end;
  // a monitor that goes down from slow closes its slow alert on the way,
  // since no "back to normal" will come for it.
  const slowness =
    event.kind === "went-slow" || event.kind === "back-to-normal";
  const key = `statoss:${event.site}:${event.monitor}`;
  return {
    event: event.kind,
    subject,
    lines,
    pageUrl: event.pageUrl,
    webhook: webhookPayload(event),
    ntfy: NTFY[event.kind],
    pushover: pushoverOf(event.kind),
    pager: {
      action:
        event.kind === "recovered" || event.kind === "back-to-normal"
          ? "resolve"
          : "trigger",
      key: slowness ? `${key}:slow` : key,
      ...(event.kind === "went-down" && event.wasSlow
        ? { closes: [`${key}:slow`] }
        : {}),
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
    pushover: QUIET,
    pager: null,
  };
}

/**
 * A vendor's change goes to the channels a person reads: email, Slack,
 * Discord, ntfy, Telegram, Pushover and Teams. A pager or a webhook is for
 * your own outages.
 */
export function vendorMessage(event: VendorEvent): Message {
  const { subject, lines } = describeVendor(event);
  return {
    event: event.kind,
    subject,
    lines,
    pageUrl: event.pageUrl,
    webhook: null,
    ntfy: NTFY[event.kind],
    pushover: QUIET,
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

/** Cuts text to at most `max` characters, ending in "…" when it was longer. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  // Never half a surrogate pair, which would not be valid text.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Text for Telegram's HTML: the three characters it reads, and quotes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Telegram takes 4,096 characters of text in a message. */
const TELEGRAM_MAX = 4096;

/**
 * Telegram's sendMessage: the subject in bold, the lines, and the page.
 * Every value is escaped, so nothing in a monitor's name or an error is
 * read as markup. The link is plain text, which Telegram makes a link
 * when it can, and which an address it cannot link (localhost) does not
 * make fail.
 */
export function telegramPayload(
  message: Message,
  chat: string,
): Record<string, unknown> {
  const subject = clip(message.subject, 256);
  const page = `Status page: ${message.pageUrl}`;
  const body = clip(
    message.lines.join("\n"),
    Math.max(0, TELEGRAM_MAX - subject.length - page.length - 2),
  );
  return {
    chat_id: chat,
    text: [
      `<b>${escapeHtml(subject)}</b>`,
      body && escapeHtml(body),
      escapeHtml(page),
    ]
      .filter((part) => part !== "")
      .join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

/**
 * Pushover's messages API, as form fields. Its limits: a title of 250
 * characters, a message of 1,024.
 */
export function pushoverPayload(
  message: Message,
  d: { pushover: string; token: string; emergency?: boolean },
): Record<string, string> {
  const emergency = d.emergency === true && message.pushover.emergency;
  return {
    token: d.token,
    user: d.pushover,
    title: clip(message.subject, 250),
    message: clip(message.lines.join("\n") || message.subject, 1024),
    url: message.pageUrl,
    url_title: "Status page",
    priority: emergency ? "2" : String(message.pushover.priority),
    // Repeated every minute until acknowledged, for three hours at most.
    ...(emergency ? { retry: "60", expire: "10800" } : {}),
  };
}

/**
 * One Adaptive Card, the form a Teams workflow posts. Text runs, not text
 * blocks: a text block reads Markdown, and the words are shown as written.
 */
export function teamsPayload(message: Message): Record<string, unknown> {
  const paragraphs = message.lines.map((line) => clip(line, 4000));
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "RichTextBlock",
              inlines: [
                {
                  type: "TextRun",
                  text: message.subject,
                  weight: "Bolder",
                  size: "Medium",
                },
              ],
            },
            ...paragraphs.map((p) => ({
              type: "RichTextBlock",
              inlines: [{ type: "TextRun", text: p }],
            })),
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Status page",
              url: message.pageUrl,
            },
          ],
        },
      },
    ],
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
  | "email"
  | "slack"
  | "discord"
  | "webhook"
  | "pagerduty"
  | "opsgenie"
  | "ntfy"
  | "telegram"
  | "pushover"
  | "teams";

export interface AlertResult {
  channel: ChannelName;
  ok: boolean;
  error?: string;
}

const PAGERDUTY_EVENTS = "https://events.pagerduty.com/v2/enqueue";
const TELEGRAM_API = "https://api.telegram.org";
const PUSHOVER_MESSAGES = "https://api.pushover.net/1/messages.json";

/**
 * A send refused for a reason that trying again cannot fix: a wrong token,
 * a chat or a workflow that is gone, a bot that was blocked. It is logged
 * with the reason and not retried.
 */
export class SetupError extends Error {}

/** Whether a refusal is the setup's fault: a 4xx, but not 408 or 429. */
export function isSetupStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What an API's error body says: Telegram's description (and a group's
 * new chat id, once it became a supergroup), Pushover's errors, a
 * workflow's error message, or short plain text. Never an HTML page.
 */
export function refusalText(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const plain = text.replace(/\s+/g, " ").trim();
    return plain.startsWith("<") ? "" : clip(plain, 300);
  }
  if (!isRecord(body)) return "";
  const error = isRecord(body.error) ? body.error : {};
  let said =
    typeof body.description === "string"
      ? body.description
      : Array.isArray(body.errors)
        ? body.errors.filter((e) => typeof e === "string").join("; ")
        : typeof error.message === "string"
          ? error.message
          : typeof body.message === "string"
            ? body.message
            : "";
  const moved = isRecord(body.parameters)
    ? body.parameters.migrate_to_chat_id
    : undefined;
  if (typeof moved === "number") said += `; the chat id is now ${moved}`;
  return clip(said.replace(/\s+/g, " ").trim(), 300);
}

/** What to look at when a channel refuses a send for good. */
const SETUP_HINTS: Record<
  "telegram" | "pushover" | "teams",
  (status: number) => string
> = {
  telegram: (status) =>
    status === 401 || status === 404
      ? "Check the bot token."
      : status === 403
        ? "Add the bot to the chat again, or unblock it."
        : "Check the chat id, and that the bot is in the chat and may post there.",
  pushover: () => "Check the user key and the application token.",
  teams: () => "Check the workflow URL, and that the workflow is turned on.",
};

/**
 * Posts to Telegram, Pushover or a Teams workflow. A refusal says what the
 * service said; one that is the setup's fault is a SetupError, with what
 * to check.
 */
async function postOrRefuse(
  fetchFn: typeof fetch,
  channel: keyof typeof SETUP_HINTS,
  url: string,
  body: string,
  contentType: string,
): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) {
    void res.body?.cancel().catch(() => {});
    return;
  }
  const said = refusalText(await res.text().catch(() => ""));
  // The host only: Telegram's address holds the bot token.
  const answer = `${new URL(url).host} answered ${res.status}`;
  if (!isSetupStatus(res.status))
    throw new Error(said ? `${answer}: ${said}` : answer);
  const hint = SETUP_HINTS[channel](res.status);
  throw new SetupError(
    said
      ? `${answer}: ${said.replace(/\.?$/, ".")} ${hint}`
      : `${answer}. ${hint}`,
  );
}

export function channelOf(d: Destination): ChannelName {
  if ("email" in d) return "email";
  if ("slack" in d) return "slack";
  if ("discord" in d) return "discord";
  if ("pagerduty" in d) return "pagerduty";
  if ("opsgenie" in d) return "opsgenie";
  if ("ntfy" in d) return "ntfy";
  if ("telegram" in d) return "telegram";
  if ("pushover" in d) return "pushover";
  if ("teams" in d) return "teams";
  return "webhook";
}

/**
 * Closes other alerts on a pager beside the one being sent, never before
 * it: a close that fails is logged and must not hold up or sink the alert
 * itself, least of all a monitor going down.
 */
function closeAside(
  keys: string[] | undefined,
  subject: string,
  close: (key: string) => Promise<void>,
): void {
  for (const key of keys ?? [])
    close(key).catch((err: unknown) =>
      console.error(
        `[alerts] closing ${key} for "${subject}" failed: ${reasonOf(err)}`,
      ),
    );
}

/**
 * Sends one message to one destination. Null when the destination has no
 * use for it: an email without SMTP, a notice to a pager, a vendor's change
 * to a webhook.
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
    const pager = message.pager;
    if (pager === null) return null;
    closeAside(pager.closes, message.subject, (closed) =>
      post(
        deps.fetch,
        PAGERDUTY_EVENTS,
        JSON.stringify({
          routing_key: d.pagerduty,
          event_action: "resolve",
          dedup_key: closed,
        }),
        {},
      ),
    );
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
    const pager = message.pager;
    const close = (key: string) =>
      post(
        deps.fetch,
        `${base}/v2/alerts/${encodeURIComponent(key)}/close?identifierType=alias`,
        JSON.stringify({ source: "StatOSS", note: message.subject }),
        headers,
      );
    closeAside(pager.closes, message.subject, close);
    return pager.action === "trigger"
      ? post(
          deps.fetch,
          `${base}/v2/alerts`,
          JSON.stringify(opsgeniePayload(message)),
          headers,
        )
      : close(pager.key);
  }
  if ("ntfy" in d)
    return post(
      deps.fetch,
      d.ntfy,
      text,
      {
        title: headerText(message.subject),
        priority: message.ntfy.priority,
        tags: message.ntfy.tags,
        click: message.pageUrl,
        ...(d.token ? { authorization: `Bearer ${d.token}` } : {}),
      },
      "text/plain; charset=utf-8",
    );
  if ("telegram" in d)
    return postOrRefuse(
      deps.fetch,
      "telegram",
      `${TELEGRAM_API}/bot${d.token}/sendMessage`,
      JSON.stringify(telegramPayload(message, d.telegram)),
      "application/json",
    );
  if ("pushover" in d)
    return postOrRefuse(
      deps.fetch,
      "pushover",
      PUSHOVER_MESSAGES,
      new URLSearchParams(pushoverPayload(message, d)).toString(),
      "application/x-www-form-urlencoded",
    );
  if ("teams" in d)
    return postOrRefuse(
      deps.fetch,
      "teams",
      d.teams,
      JSON.stringify(teamsPayload(message)),
      "application/json",
    );
  if (message.webhook === null) return null;
  const body = JSON.stringify(message.webhook);
  return post(deps.fetch, d.webhook, body, {
    "x-statoss-event": message.event,
    "x-statoss-signature": signWebhook(d.secret, body),
  });
}

/**
 * Text for an HTTP header: one line, and RFC 2047 encoded when it is not
 * plain ASCII, which ntfy reads and fetch would otherwise refuse.
 */
export function headerText(text: string): string {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(line)
    ? line
    : `=?UTF-8?B?${Buffer.from(line, "utf8").toString("base64")}?=`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Logs a send that failed, and says whether to try it again: not when the
 * destination is set up wrong, since the same send would fail the same way.
 */
function logFailure(
  channel: ChannelName,
  message: Message,
  err: unknown,
): boolean {
  if (err instanceof SetupError) {
    console.error(
      `[alerts] ${channel} refused "${message.subject}", not trying again: ${err.message}`,
    );
    return false;
  }
  console.error(
    `[alerts] ${channel} failed for "${message.subject}": ${reasonOf(err)}`,
  );
  return true;
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
        if (logFailure(channel, message, err))
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
    if (logFailure(channel, message, result.reason))
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

export function sendVendorAlert(
  destinations: Destination[],
  event: VendorEvent,
  deps: AlertDeps,
  stillHolds?: () => boolean,
): Promise<AlertResult[]> {
  return sendMessage(destinations, vendorMessage(event), deps, stillHolds);
}

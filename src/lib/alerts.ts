import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config";
import { formatDuration } from "./format";

export { formatDuration };

export interface AlertEvent {
  site: string;
  checkpoint: string;
  url: string;
  transition: "went-down" | "recovered";
  error?: string | null;
  downSince?: number;
  now: number;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<unknown>;

export function buildAlertEmail(event: AlertEvent): {
  subject: string;
  text: string;
} {
  const timestamp = new Date(event.now).toISOString();
  if (event.transition === "went-down") {
    return {
      subject: `🔴 ${event.site}: ${event.checkpoint} is DOWN`,
      text: `${event.checkpoint} (${event.url}) is failing.\n\nError: ${event.error ?? "unknown"}\nTime: ${timestamp}`,
    };
  }
  const duration =
    event.downSince !== undefined
      ? formatDuration(event.now - event.downSince)
      : "unknown";
  return {
    subject: `🟢 ${event.site}: ${event.checkpoint} recovered`,
    text: `${event.checkpoint} (${event.url}) is back up.\n\nDowntime: ${duration}\nTime: ${timestamp}`,
  };
}

function smtpSend(smtp: SmtpConfig): SendMail {
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

export async function sendAlert(
  smtp: SmtpConfig,
  event: AlertEvent,
  send: SendMail = smtpSend(smtp),
): Promise<void> {
  const mail: Mail = {
    from: smtp.from,
    to: smtp.to,
    ...buildAlertEmail(event),
  };
  try {
    await send(mail);
  } catch (err) {
    console.error("[alerts] failed to send email", err);
  }
}

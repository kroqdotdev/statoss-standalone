import { describe, expect, it, vi } from "vitest";
import {
  buildAlertEmail,
  formatDuration,
  sendAlert,
  type Mail,
} from "./alerts";
import type { SmtpConfig } from "./config";

const SMTP: SmtpConfig = {
  host: "mail.example.com",
  port: 587,
  user: "postmaster@example.com",
  from: "status@example.com",
  to: "alerts@example.com",
};

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(3 * 60_000)).toBe("3 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
  });
});

describe("buildAlertEmail", () => {
  it("describes a down transition with the error", () => {
    const { subject, text } = buildAlertEmail({
      site: "webhooks.cc",
      checkpoint: "Redirector",
      url: "https://go.webhooks.cc",
      transition: "went-down",
      error: "timeout",
      now: 1_700_000_000_000,
    });
    expect(subject).toContain("webhooks.cc");
    expect(subject).toContain("Redirector");
    expect(subject).toContain("DOWN");
    expect(text).toContain("https://go.webhooks.cc");
    expect(text).toContain("timeout");
  });

  it("describes a recovery with the outage duration", () => {
    const now = 1_700_000_000_000;
    const { subject, text } = buildAlertEmail({
      site: "webhooks.cc",
      checkpoint: "Main site",
      url: "https://webhooks.cc",
      transition: "recovered",
      downSince: now - 10 * 60_000,
      now,
    });
    expect(subject).toContain("recovered");
    expect(text).toContain("10 min");
  });
});

describe("sendAlert", () => {
  const event = {
    site: "s",
    checkpoint: "c",
    url: "https://example.com",
    transition: "went-down" as const,
    error: "boom",
    now: 0,
  };

  it("sends via the injected transport with configured from/to", async () => {
    const send = vi
      .fn<(mail: Mail) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    await sendAlert(SMTP, event, send);
    expect(send).toHaveBeenCalledOnce();
    const mail = send.mock.calls[0][0];
    expect(mail.from).toBe("status@example.com");
    expect(mail.to).toBe("alerts@example.com");
    expect(mail.subject).toContain("DOWN");
  });

  it("never throws when the transport fails", async () => {
    const send = vi
      .fn<(mail: Mail) => Promise<unknown>>()
      .mockRejectedValue(new Error("smtp down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendAlert(SMTP, event, send)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

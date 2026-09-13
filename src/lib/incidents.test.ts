import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";
import {
  autoIncidentView,
  inMaintenance,
  maintenancePhase,
  maintenanceView,
  openImpacts,
  parseIncidentFile,
  splitFrontMatter,
  splitIncidents,
  type IncidentView,
} from "./incidents";

const CONFIG = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    checkpoints:
      - name: Main site
        url: https://webhooks.cc
      - name: API
        url: https://api.webhooks.cc
`);

const TWO_SITES = parseConfig(`
sites:
  - name: one
    host: one.example
    checkpoints:
      - name: Home
        url: https://one.example
  - name: two
    host: two.example
    checkpoints:
      - name: Home
        url: https://two.example
`);

const T = Date.UTC(2026, 8, 12, 14, 5);
const HOUR = 60 * 60_000;

const MARKDOWN = `---
title: Elevated API errors
started: 2026-09-12T14:05:00Z
impact: partial
checkpoints: [API]
updates:
  - at: 2026-09-12 14:05
    status: investigating
    body: We are looking into elevated error rates.
  - at: 2026-09-12 15:10
    status: resolved
    body: A failover completed and errors have stopped.
---

The primary database ran out
of connections.


We raised the limit.
`;

describe("splitFrontMatter", () => {
  it("separates the YAML from the text below", () => {
    expect(splitFrontMatter("---\na: 1\n---\nbody\n")).toEqual({
      front: "a: 1",
      body: "body\n",
    });
    expect(splitFrontMatter("---\r\na: 1\r\n---\r\nbody")).toEqual({
      front: "a: 1",
      body: "body",
    });
    expect(splitFrontMatter("---\na: 1\n---")).toEqual({
      front: "a: 1",
      body: "",
    });
    expect(splitFrontMatter("a: 1\n")).toEqual({ front: "a: 1\n", body: "" });
  });
});

describe("parseIncidentFile", () => {
  it("reads a Markdown file with front matter and a post-mortem", () => {
    const { site, view } = parseIncidentFile(
      "2026-09-12-api-errors.md",
      MARKDOWN,
      CONFIG,
    );
    expect(site.name).toBe("webhooks.cc");
    expect(view).toMatchObject({
      id: "2026-09-12-api-errors",
      kind: "incident",
      title: "Elevated API errors",
      status: "resolved",
      impact: "partial",
      startedAt: T,
      resolvedAt: Date.UTC(2026, 8, 12, 15, 10),
      auto: false,
      checkpoints: ["API"],
    });
    expect(view.updates.map((u) => u.status)).toEqual([
      "resolved",
      "investigating",
    ]);
    expect(view.postmortem).toBe(
      "The primary database ran out of connections.\n\nWe raised the limit.",
    );
  });

  it("reads a YAML file and treats a missing resolution as open", () => {
    const { view } = parseIncidentFile(
      "open.yaml",
      `title: Slow uploads
started: 2026-09-12T14:05:00Z
updates:
  - at: 2026-09-12T14:05:00Z
    status: identified
    body: The storage provider is degraded.
`,
      CONFIG,
    );
    expect(view).toMatchObject({
      id: "open",
      status: "identified",
      impact: "none",
      resolvedAt: null,
      checkpoints: [],
      postmortem: null,
    });
  });

  it("takes an explicit resolved time", () => {
    const { view } = parseIncidentFile(
      "r.yml",
      "title: x\nstarted: 2026-09-12T14:05:00Z\nresolved: 2026-09-12T14:35:00Z\n",
      CONFIG,
    );
    expect(view.status).toBe("resolved");
    expect(view.resolvedAt).toBe(T + 30 * 60_000);
  });

  it("needs a site name when there is more than one site", () => {
    const text = "title: x\nstarted: 2026-09-12T14:05:00Z\n";
    expect(() => parseIncidentFile("a.yaml", text, TWO_SITES)).toThrow(
      /name the site/,
    );
    expect(
      parseIncidentFile("a.yaml", text + "site: two.example\n", TWO_SITES).site
        .name,
    ).toBe("two");
    expect(() =>
      parseIncidentFile("a.yaml", text + "site: three\n", TWO_SITES),
    ).toThrow(/no site named "three"/);
  });

  it("rejects unknown checkpoints and bad fields with the file name", () => {
    expect(() =>
      parseIncidentFile(
        "bad.md",
        "---\ntitle: x\nstarted: 2026-09-12\ncheckpoints: [Nope]\n---\n",
        CONFIG,
      ),
    ).toThrow(/bad\.md: "Nope" is not a checkpoint/);
    expect(() =>
      parseIncidentFile(
        "bad.md",
        "---\ntitle: x\nstarted: soon\n---\n",
        CONFIG,
      ),
    ).toThrow(/bad\.md: started: "soon" is not a date/);
    expect(() =>
      parseIncidentFile("bad.md", "---\nstarted: 2026-09-12\n---\n", CONFIG),
    ).toThrow(/bad\.md: title/);
  });
});

describe("maintenance", () => {
  const window = {
    title: "Database upgrade",
    start: T,
    end: T + 2 * HOUR,
    checkpoints: ["API"],
    notes: "Writes pause for a minute.",
  };

  it("covers named checkpoints while the window is open", () => {
    expect(inMaintenance([window], "API", T)).toBe(true);
    expect(inMaintenance([window], "API", T + 2 * HOUR)).toBe(false);
    expect(inMaintenance([window], "API", T - 1)).toBe(false);
    expect(inMaintenance([window], "Main site", T)).toBe(false);
    expect(
      inMaintenance([{ ...window, checkpoints: undefined }], "Main site", T),
    ).toBe(true);
  });

  it("makes a view with the notes as its one update", () => {
    const view = maintenanceView(window, 0);
    expect(view).toMatchObject({
      id: "maintenance-0",
      kind: "maintenance",
      startedAt: T,
      endsAt: T + 2 * HOUR,
      checkpoints: ["API"],
    });
    expect(view.updates[0].body).toBe("Writes pause for a minute.");
    expect(maintenancePhase(view, T - 1)).toBe("scheduled");
    expect(maintenancePhase(view, T)).toBe("in-progress");
    expect(maintenancePhase(view, T + 2 * HOUR)).toBe("completed");
  });
});

describe("autoIncidentView", () => {
  it("describes an outage the checker opened", () => {
    const open = autoIncidentView({
      id: 7,
      site: "s",
      checkpoint: "API",
      startedAt: T,
      resolvedAt: null,
      error: "timeout",
    });
    expect(open).toMatchObject({
      id: "auto-7",
      title: "API is down",
      status: "investigating",
      auto: true,
      checkpoints: ["API"],
    });
    expect(open.updates[0].body).toContain("(timeout)");
    const closed = autoIncidentView({
      id: 7,
      site: "s",
      checkpoint: "API",
      startedAt: T,
      resolvedAt: T + 12 * 60_000,
      error: null,
    });
    expect(closed.status).toBe("resolved");
    expect(closed.updates[0].body).toBe(
      "Recovered after 12 min. Resolved automatically.",
    );
  });
});

describe("splitIncidents", () => {
  const base: IncidentView = {
    id: "x",
    kind: "incident",
    title: "x",
    status: "investigating",
    impact: "none",
    startedAt: T,
    endsAt: null,
    resolvedAt: null,
    auto: false,
    postmortem: null,
    checkpoints: [],
    updates: [],
  };
  const now = T + 5 * HOUR;

  it("puts open incidents first, then maintenance in progress, then planned", () => {
    const views: IncidentView[] = [
      {
        ...base,
        id: "planned",
        kind: "maintenance",
        startedAt: now + HOUR,
        endsAt: now + 2 * HOUR,
      },
      { ...base, id: "old-open", startedAt: T - HOUR },
      {
        ...base,
        id: "running",
        kind: "maintenance",
        startedAt: now - HOUR,
        endsAt: now + HOUR,
      },
      { ...base, id: "new-open" },
      { ...base, id: "done", resolvedAt: T + HOUR },
      {
        ...base,
        id: "finished",
        kind: "maintenance",
        startedAt: T,
        endsAt: T + HOUR,
      },
      {
        ...base,
        id: "far",
        kind: "maintenance",
        startedAt: now + 10 * 24 * HOUR,
        endsAt: now + 11 * 24 * HOUR,
      },
      {
        ...base,
        id: "ancient",
        startedAt: now - 40 * 24 * HOUR,
        resolvedAt: now - 39 * 24 * HOUR,
      },
    ];
    const { current, past } = splitIncidents(views, now);
    expect(current.map((v) => v.id)).toEqual([
      "new-open",
      "old-open",
      "running",
      "planned",
    ]);
    expect(past.map((v) => v.id)).toEqual(["done", "finished"]);
    expect(openImpacts(current)).toEqual(["none", "none"]);
  });
});

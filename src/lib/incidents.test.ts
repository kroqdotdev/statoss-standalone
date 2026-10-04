import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";
import {
  autoIncidentView,
  foldAutomatic,
  joinLines,
  postmortemBlocks,
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
    monitors:
      - name: Main site
        url: https://webhooks.cc
      - name: API
        url: https://api.webhooks.cc
`);

const TWO_SITES = parseConfig(`
sites:
  - name: one
    host: one.example
    monitors:
      - name: Home
        url: https://one.example
  - name: two
    host: two.example
    monitors:
      - name: Home
        url: https://two.example
`);

const T = Date.UTC(2026, 8, 12, 14, 5);
const HOUR = 60 * 60_000;

const MARKDOWN = `---
title: Elevated API errors
started: 2026-09-12T14:05:00Z
impact: partial
monitors: [API]
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
      states: {},
      monitors: ["API"],
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
      monitors: [],
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

  it("rejects unknown monitors and bad fields with the file name", () => {
    expect(() =>
      parseIncidentFile(
        "bad.md",
        "---\ntitle: x\nstarted: 2026-09-12\nmonitors: [Nope]\n---\n",
        CONFIG,
      ),
    ).toThrow(/bad\.md: "Nope" is not a monitor/);
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
    monitors: ["API"],
    notes: "Writes pause for a minute.",
  };

  it("makes a view with the notes as its one update", () => {
    const view = maintenanceView(window);
    expect(view).toMatchObject({
      id: "maintenance-2026-09-12-1405-database-upgrade",
      kind: "maintenance",
      startedAt: T,
      endsAt: T + 2 * HOUR,
      monitors: ["API"],
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
      monitor: "API",
      startedAt: T,
      resolvedAt: null,
      error: "timeout",
    });
    expect(open).toMatchObject({
      id: "auto-7",
      title: "API is down",
      status: "investigating",
      auto: true,
      monitors: ["API"],
    });
    expect(open.updates[0].body).toContain("(timeout)");
    const closed = autoIncidentView({
      id: 7,
      site: "s",
      monitor: "API",
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
    states: {},
    postmortem: null,
    monitors: [],
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

describe("states for the rows an incident names", () => {
  const config = parseConfig(`
sites:
  - name: shop
    host: status.shop.example
    monitors:
      - name: API
        url: https://api.shop.example
    components:
      - name: Mobile app
`);

  it("reads a name alone, or a name with a state, for monitors and components", () => {
    const { view } = parseIncidentFile(
      "x.yaml",
      `title: x
started: 2026-09-12T14:05:00Z
monitors:
  - API
  - name: Mobile app
    state: degraded
`,
      config,
    );
    expect(view.monitors).toEqual(["API", "Mobile app"]);
    expect(view.states).toEqual({ "Mobile app": "degraded" });
  });

  it("rejects a name that is neither", () => {
    expect(() =>
      parseIncidentFile(
        "x.yaml",
        "title: x\nstarted: 2026-09-12\nmonitors: [{name: Nope, state: major}]\n",
        config,
      ),
    ).toThrow('"Nope" is not a monitor or component of shop');
  });
});

describe("post-mortems", () => {
  it("keeps a heading as a block of its own", () => {
    const text = joinLines(
      "## What happened\nThe pool ran\nout.\n\n## What we changed\n\nA limit.",
    );
    expect(postmortemBlocks(text)).toEqual([
      { heading: true, text: "What happened" },
      { heading: false, text: "The pool ran out." },
      { heading: true, text: "What we changed" },
      { heading: false, text: "A limit." },
    ]);
  });
});

describe("the order of what is current", () => {
  const base = {
    kind: "incident" as const,
    status: "investigating" as const,
    endsAt: null,
    resolvedAt: null,
    postmortem: null,
    states: {},
    monitors: [] as string[],
    updates: [] as IncidentView["updates"],
  } satisfies Partial<IncidentView>;
  const views: IncidentView[] = [
    {
      ...base,
      id: "auto-1",
      title: "A is down",
      impact: "none",
      auto: true,
      startedAt: T,
      monitors: ["A"],
    },
    {
      ...base,
      id: "minor",
      title: "Minor",
      impact: "degraded",
      auto: false,
      startedAt: T + 5,
    },
    {
      ...base,
      id: "auto-2",
      title: "B is down",
      impact: "none",
      auto: true,
      startedAt: T + 1,
      monitors: ["B"],
    },
    {
      ...base,
      id: "major",
      title: "Major",
      impact: "major",
      auto: false,
      startedAt: T,
    },
    {
      ...base,
      id: "later",
      title: "Later",
      impact: "major",
      auto: false,
      startedAt: T + 10 * HOUR,
    },
  ];

  it("puts what somebody wrote first, the worst first, and leaves out what has not started", () => {
    const { current } = splitIncidents(views, T + HOUR);
    expect(current.map((v) => v.id)).toEqual([
      "major",
      "minor",
      "auto-2",
      "auto-1",
    ]);
  });

  it("folds several automatic outages into one card", () => {
    const { current } = splitIncidents(views, T + HOUR);
    const folded = foldAutomatic(current);
    expect(folded.map((v) => v.title)).toEqual([
      "Major",
      "Minor",
      "2 monitors are down",
    ]);
    expect(folded[2].monitors).toEqual(["B", "A"]);
    expect(folded[2].startedAt).toBe(T);
    expect(foldAutomatic(current.slice(0, 3))).toEqual(current.slice(0, 3));
  });

  it("lists the last seven days as past on the page", () => {
    const old: IncidentView = {
      ...base,
      id: "old",
      title: "Old",
      impact: "none",
      auto: false,
      startedAt: T - 8 * 24 * HOUR,
      resolvedAt: T - 8 * 24 * HOUR + 1,
    };
    const recent = { ...old, id: "recent", startedAt: T - 2 * 24 * HOUR };
    expect(splitIncidents([old, recent], T).past.map((v) => v.id)).toEqual([
      "recent",
    ]);
    expect(splitIncidents([old, recent], T, 30).past).toHaveLength(2);
  });
});

describe("the example files", () => {
  it("all parse against the example configuration, templates included", () => {
    // The example names variables in its comments; any value will do.
    const env = new Proxy({}, { get: () => "x" });
    const config = parseConfig(
      readFileSync("config.example.yaml", "utf8"),
      env,
    );
    const files = [
      ...readdirSync("incidents.example")
        .filter((f) => /\.(md|ya?ml)$/.test(f))
        .map((f) => join("incidents.example", f)),
      ...readdirSync("incidents.example/templates").map((f) =>
        join("incidents.example/templates", f),
      ),
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files)
      expect(() =>
        parseIncidentFile(file, readFileSync(file, "utf8"), config),
      ).not.toThrow();
  });
});

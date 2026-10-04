import { expect, LOCKED, test, walkBack } from "./journeys";

test.describe("the status page", () => {
  test("says what is wrong, in order, and shows every row", async ({
    page,
    fits,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Part of Northwind is down.",
    );
    await expect(
      page.getByText("Everything Northwind runs for its customers."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Contact support" }),
    ).toHaveAttribute("href", "mailto:help@northwind.example");

    // What somebody wrote comes first, then maintenance.
    const cards = page.getByLabel("Current incidents").getByRole("article");
    await expect(cards.first()).toContainText(
      "Uploads are failing for some customers",
    );
    await expect(cards.first()).toContainText("Identified");
    await expect(cards.last()).toContainText("Maintenance: Database upgrade");

    // The rows: what the incident says, the window, a component.
    const website = page.locator("#row-website");
    await expect(website.getByRole("link", { name: "Degraded" })).toBeVisible();
    await expect(page.locator("#row-database-port")).toContainText(
      "Under maintenance",
    );
    await expect(page.locator("#row-mobile-app")).toContainText(
      "Partial outage",
    );
    await expect(page.locator("#row-card-payments")).toContainText("Degraded");
    // Waiting, unless the desktop run's journey below has pinged it.
    await expect(page.locator("#row-nightly-backup")).toContainText(
      /Waiting for the first ping|Up for/,
    );
    // The check that answers 503 goes down after two rounds.
    await expect(page.locator("#row-exports")).toContainText("Down for", {
      timeout: 45_000,
    });

    await expect(page.locator("footer")).toContainText(
      "against a 99.9% target",
    );
    await expect(page.locator("footer")).toContainText(
      "Times are in your time zone",
    );
    await fits("the status page");
  });

  test("opens a bar to the checks behind it, and names a deploy", async ({
    page,
    fits,
  }) => {
    await page.goto("/");
    const strip = page.locator("#row-website").getByRole("img");
    await strip.focus();
    // The newest bar, then back to the outage five hours ago.
    const bar = page.locator("#row-website").locator("p[aria-live]");
    expect(await walkBack(page, bar, "failed check", 75)).toBe(true);
    await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: /^Checks for Website/ });
    await expect(panel).toContainText("HTTP 503");
    await fits("an open bar");
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);

    await expect(page.getByText("deploy", { exact: true })).toBeVisible();
    // Three hours back, where the release went out.
    // Where the bar under it falls depends on the minute, so walk back to it.
    await strip.focus();
    const readout = page.locator("#row-website").locator("p[aria-live]");
    expect(await walkBack(page, readout, "Deploy: v1.4.0.", 45)).toBe(true);
  });

  test("has a year of history on the longer views", async ({ page, fits }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "1 year" }).click();
    await expect(page).toHaveURL(/range=1y/);
    await expect(page.locator("#row-website")).toContainText(
      /\d{3},\d{3} checks/,
    );
    await expect(page.locator("footer")).toContainText(
      "Failed checks are listed for the last 90 days",
    );
    await fits("the year view");
    await page.getByRole("link", { name: "7 days" }).click();
    await expect(page).toHaveURL(/range=7d/);
    await fits("the week view");
  });
});

test.describe("incidents", () => {
  test("have a page each, with the post-mortem, and a history by month", async ({
    page,
    fits,
  }) => {
    await page.goto("/");
    await page
      .getByLabel("Past incidents")
      .getByRole("link", { name: "Slow search" })
      .click();
    await expect(page).toHaveURL(/\/incidents\/slow-search$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Slow search",
    );
    await expect(
      page.getByRole("heading", { name: "What happened" }),
    ).toBeVisible();
    await expect(page.getByText("Resolved.")).toBeVisible();
    await fits("an incident's page");

    await page.getByRole("link", { name: "Northwind status" }).click();
    await page.getByRole("link", { name: "Incident history" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Incident history",
    );
    await expect(page.getByRole("link", { name: "Slow search" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Maintenance: Router swap" }),
    ).toBeVisible();
    await fits("the history");
    // The outage of five months ago is on the next page of three months.
    await page.getByRole("link", { name: "Earlier" }).click();
    await expect(
      page.getByRole("link", { name: "DNS provider outage" }),
    ).toBeVisible();
  });

  test("an address that names no incident is not found", async ({ page }) => {
    const response = await page.goto("/incidents/nothing-here");
    expect(response?.status()).toBe(404);
  });
});

test.describe("a password page", () => {
  test("shows a form until the password is given, and locks its endpoints", async ({
    page,
    request,
    fits,
  }) => {
    expect((await request.get(`${LOCKED}/status.json`)).status()).toBe(401);
    expect((await request.get(`${LOCKED}/feed.xml`)).status()).toBe(401);
    expect(
      (
        await request.get(`${LOCKED}/status.json?key=journey-embed-key`)
      ).status(),
    ).toBe(200);

    await page.goto(`${LOCKED}/`);
    await expect(page.getByText("This page needs a password.")).toBeVisible();
    await expect(page.getByText("Wiki")).toHaveCount(0);
    await fits("the password form");

    await page.getByLabel("Password").fill("not-it");
    await page.getByRole("button", { name: "Open the page" }).click();
    await expect(page.getByText("That is not the password.")).toBeVisible();

    await page.getByLabel("Password").fill("journey-password");
    await page.getByRole("button", { name: "Open the page" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Internal tools",
    );
    await expect(page.getByRole("heading", { name: "Wiki" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await fits("the unlocked page");

    // The browser that gave the password reads the endpoints too.
    const status = await page.request.get(`${LOCKED}/status.json`);
    expect(status.status()).toBe(200);
  });
});

test.describe("for programs", () => {
  test("status.json, the feeds, the badge, the MCP endpoint and llms.txt answer", async ({
    request,
  }) => {
    const status = await (await request.get("/status.json")).json();
    expect(status.site.name).toBe("Northwind");
    expect(status.monitors).toHaveLength(6);
    expect(status.components.map((c: { name: string }) => c.name)).toEqual([
      "Mobile app",
      "Card payments",
    ]);
    expect(status.budget.target).toBe(99.9);
    expect(status.deploys.map((d: { version: string }) => d.version)).toContain(
      "v1.4.0",
    );
    expect(status.incidents[0].title).toBe(
      "Uploads are failing for some customers",
    );

    const rss = await (await request.get("/feed.xml")).text();
    expect(rss).toContain("/incidents/slow-search</link>");
    const atom = await (await request.get("/feed.atom")).text();
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(
      (await request.get("/badge.svg")).headers()["content-type"],
    ).toContain("image/svg+xml");
    expect(await (await request.get("/llms.txt")).text()).toContain(
      "# Northwind status",
    );

    const tools = await (
      await request.post("/mcp", {
        data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
    ).json();
    expect(tools.result.tools).toHaveLength(3);
    const budget = await (
      await request.post("/mcp", {
        data: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_error_budget" },
        },
      })
    ).json();
    expect(budget.result.content[0].text).toContain("against a 99.9% target");
  });

  test("a heartbeat is pinged and a deploy is posted with its token only", async ({
    request,
  }) => {
    expect((await request.get("/heartbeat/journey-heartbeat")).status()).toBe(
      200,
    );
    // A ping is judged at once: the monitor is up without waiting its turn.
    const status = await (await request.get("/status.json")).json();
    expect(
      status.monitors.find((m: { name: string }) => m.name === "Nightly backup")
        .status,
    ).toBe("up");
    expect((await request.get("/heartbeat/some-other-token")).status()).toBe(
      404,
    );
    expect(
      (await request.post("/deploys", { data: { version: "v9" } })).status(),
    ).toBe(401);
    const posted = await request.post("/deploys", {
      headers: { authorization: "Bearer journey-deploy-token" },
      data: { version: "v1.4.1", note: "From the journey" },
    });
    expect(posted.status()).toBe(201);
    const list = await (await request.get("/deploys")).json();
    expect(list[0].version).toBe("v1.4.1");
  });
});

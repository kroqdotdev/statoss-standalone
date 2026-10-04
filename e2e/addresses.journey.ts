import type { APIRequestContext, Page } from "@playwright/test";
import { at, BASE, expect, LOCKED, test } from "./journeys";

/**
 * Every address the app hands out stays under the base path and answers:
 * what each page links to and loads, the addresses inside the feeds, the
 * calendar, llms.txt and status.json, the widget's, and the password
 * cookie's path. Without a base path the same holds for the root.
 */

const ORIGIN = "http://localhost:3222";

/** The base path itself, or a path under it. */
function underBase(pathname: string): boolean {
  return !BASE || pathname === BASE || pathname.startsWith(`${BASE}/`);
}

/** Where the page's links, styles, scripts and images point. */
function pointers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], link[href], script[src], img[src]",
      ),
    ].map((el) =>
      el instanceof HTMLAnchorElement || el instanceof HTMLLinkElement
        ? el.href
        : (el as HTMLScriptElement | HTMLImageElement).src,
    ),
  );
}

/**
 * An address of the app, from a page or a feed: under the base path, and
 * answering 200 at once, with no redirect. The sites' configured hosts
 * carry no port, so the path is asked of the journeys' server.
 */
async function answers(request: APIRequestContext, address: string) {
  const url = new URL(address.replace(/^webcal:/, "http:"));
  expect(underBase(url.pathname), `${address} is under the base path`).toBe(
    true,
  );
  const response = await request.get(`${ORIGIN}${url.pathname}${url.search}`, {
    maxRedirects: 0,
  });
  expect(response.status(), `${address} answers`).toBe(200);
}

test.describe("addresses", () => {
  test("every page links to and loads only what answers, under the base path", async ({
    page,
    request,
  }) => {
    const failed: string[] = [];
    page.on("response", (response) => {
      if (response.url().startsWith(ORIGIN) && response.status() >= 400)
        failed.push(`${response.status()} ${response.url()}`);
    });
    const seen = new Set<string>();
    for (const path of ["/", "/history", "/incidents/slow-search"]) {
      const response = await page.goto(at(path));
      expect(response?.status(), path).toBe(200);
      await page.waitForLoadState("networkidle");
      for (const url of await pointers(page)) {
        const address = url.split("#")[0];
        // The site's own addresses; mailto: and other sites are not.
        if (new URL(address).hostname !== "localhost" || seen.has(address))
          continue;
        seen.add(address);
        await answers(request, address);
      }
    }
    // The feeds, the calendar, a style sheet, a script, the logo, the icon.
    for (const end of [
      "/feed.xml",
      "/feed.atom",
      "/maintenance.ics",
      "/status.json",
      "/badge.svg",
      "/widget.js",
      ".css",
      ".js",
      "/logo",
      "/icon.svg",
    ])
      expect(
        [...seen].some((a) => new URL(a).pathname.endsWith(end)),
        `a page points at ${end}`,
      ).toBe(true);
    expect(failed).toEqual([]);
  });

  test("the feeds, the calendar, llms.txt and status.json name addresses that answer", async ({
    request,
  }) => {
    for (const path of [
      "/feed.xml",
      "/feed.atom",
      "/maintenance.ics",
      "/llms.txt",
      "/status.json",
    ]) {
      const response = await request.get(at(path));
      expect(response.status(), path).toBe(200);
      // Folded calendar lines are unfolded first.
      const text = (await response.text()).replaceAll("\r\n ", "");
      const found = [
        ...new Set(text.match(/(?:https?|webcal):\/\/localhost[^\s"<>),;]*/g)),
      ];
      expect(found.length, `${path} names the site`).toBeGreaterThan(0);
      for (const address of found) {
        const { pathname } = new URL(address);
        // llms.txt describes incident pages as /incidents/<id>.
        if (pathname.endsWith("/incidents/")) continue;
        if (pathname.endsWith("/mcp")) {
          expect(underBase(pathname), address).toBe(true);
          const tools = await request.post(`${ORIGIN}${pathname}`, {
            data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          });
          expect(tools.status(), address).toBe(200);
        } else await answers(request, address);
      }
    }
  });

  test("the widget links to the page and reads status.json next to itself", async ({
    page,
  }) => {
    // A page that embeds it. It is answered here, on the server's origin:
    // Chrome keeps a page from elsewhere from loading a script off localhost.
    const embedding = `${ORIGIN}/a-page-that-embeds-the-widget`;
    await page.route(embedding, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<p><script src="${ORIGIN}${at("/widget.js")}"></script></p>`,
      }),
    );
    await page.goto(embedding);
    const link = page.getByRole("link");
    await expect(link).toHaveText("Partly down");
    expect(await link.evaluate((a) => (a as HTMLAnchorElement).href)).toBe(
      new URL(at("/"), ORIGIN).href,
    );
  });

  test("the password cookie is sent only under the base path", async ({
    page,
    context,
  }) => {
    const front = new URL(at("/"), LOCKED).href;
    // A locked page's history goes to the form.
    await page.goto(`${LOCKED}/history`);
    await expect(page).toHaveURL(front);
    await page.getByLabel("Password").fill("journey-password");
    await page.getByRole("button", { name: "Open the page" }).click();
    await expect(page.getByRole("heading", { name: "Wiki" })).toBeVisible();
    await expect(page).toHaveURL(front);
    const [cookie] = await context.cookies(front);
    expect(cookie?.name).toBe("statoss_unlock");
    expect(cookie?.path).toBe(BASE || "/");
    if (BASE)
      expect(await context.cookies(new URL("/elsewhere", LOCKED).href)).toEqual(
        [],
      );
    await page.goto(`${LOCKED}/history`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Incident history",
    );
  });
});

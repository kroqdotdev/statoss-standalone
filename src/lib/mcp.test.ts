import { describe, expect, it, vi } from "vitest";
import {
  handleMcp,
  MAX_BATCH,
  MCP_MESSAGES_PER_MINUTE,
  mcpOverLimit,
  siteTools,
} from "./mcp";

const tools = siteTools("Example", {
  status: () => ({ site: { status: "operational" } }),
  incidents: () => [],
  budget: () => null,
});
const server = { name: "Example status", version: "1" };

const post = (body: unknown) =>
  new Request("http://x/mcp", { method: "POST", body: JSON.stringify(body) });
const call = async (body: unknown) =>
  (await handleMcp(post(body), tools, server)).json();

describe("the MCP endpoint", () => {
  it("answers initialize with the version asked for, when it knows it", async () => {
    const answer = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(answer.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "Example status" },
      capabilities: { tools: {} },
    });
  });

  it("lists three tools that read, and runs them", async () => {
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "get_status",
      "list_incidents",
      "get_error_budget",
    ]);
    const status = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_status", arguments: {} },
    });
    expect(JSON.parse(status.result.content[0].text)).toEqual({
      site: { status: "operational" },
    });
    const budget = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_error_budget" },
    });
    expect(budget.result.content[0].text).toBe(
      "This site has no uptime target.",
    );
  });

  it("refuses what it does not know, and gives no internals when a tool breaks", async () => {
    expect(
      (await call({ jsonrpc: "2.0", id: 5, method: "resources/list" })).error
        .code,
    ).toBe(-32601);
    expect(
      (
        await call({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "open_incident" },
        })
      ).error.code,
    ).toBe(-32602);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await handleMcp(
      post({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_status" },
      }),
      siteTools("Example", {
        status: () => {
          throw new Error("secret path /data/status.db");
        },
        incidents: () => [],
        budget: () => null,
      }),
      server,
    );
    const body = await broken.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");
    vi.restoreAllMocks();
  });

  it("answers a batch, says nothing to a notification, and takes POST only", async () => {
    const batch = await call([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { nonsense: true },
    ]);
    expect(batch).toHaveLength(2);
    expect(batch[1].error.code).toBe(-32600);
    const quiet = await handleMcp(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      tools,
      server,
    );
    expect(quiet.status).toBe(202);
    const get = await handleMcp(new Request("http://x/mcp"), tools, server);
    expect(get.status).toBe(405);
    const bad = await handleMcp(
      new Request("http://x/mcp", { method: "POST", body: "{" }),
      tools,
      server,
    );
    expect(bad.status).toBe(400);
    const many = await handleMcp(
      post(
        Array.from({ length: MAX_BATCH + 1 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "ping",
        })),
      ),
      tools,
      server,
    );
    expect(many.status).toBe(400);
  });

  it("slows a caller down past its messages a minute", async () => {
    expect(mcpOverLimit("h.example", MCP_MESSAGES_PER_MINUTE, 0)).toBe(false);
    expect(mcpOverLimit("h.example", 1, 1000)).toBe(true);
    expect(mcpOverLimit("h.example", 1, 60_000)).toBe(false);
    const limited = await handleMcp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }),
      tools,
      server,
      () => true,
    );
    expect(limited.status).toBe(429);
  });
});

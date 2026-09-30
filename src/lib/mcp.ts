/**
 * A small Model Context Protocol server over Streamable HTTP, stateless:
 * every POST carries one JSON-RPC message (or a batch) and gets its answer
 * as JSON. No sessions, no server-sent events, no dependency. That is the
 * subset every MCP client speaks, and enough for tools that read status.
 */

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | null;
}

/** The most messages one POST may carry; each one can be a full tool call. */
export const MAX_BATCH = 20;

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function failure(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** The text a tool answers with: JSON, pretty enough to read. */
function textContent(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function dispatch(
  message: JsonRpcRequest,
  tools: McpTool[],
  server: { name: string; version: string; instructions?: string },
): Promise<unknown | undefined> {
  const { id, method } = message;
  const params =
    typeof message.params === "object" && message.params !== null
      ? message.params
      : {};
  // A message without an id is a notification: it gets no answer, whatever
  // the method. Only requests are answered.
  if (id === undefined) return undefined;
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = String(params.name ?? "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${name}`);
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return result(id, textContent(await tool.run(args)));
      } catch (err) {
        // A bug: logged here, and the client gets no internals.
        console.error(`[mcp] ${name} failed`, err);
        return result(id, {
          ...textContent("Something went wrong on the server."),
          isError: true,
        });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/** Answers one MCP request. GET and DELETE are refused: nothing here streams. */
export async function handleMcp(
  request: Request,
  tools: McpTool[],
  server: { name: string; version: string; instructions?: string },
  /**
   * Called with how many messages the request carries; true means the
   * caller is over its limit and gets a 429.
   */
  overLimit: (messages: number) => boolean = () => false,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST")
    return new Response("Send JSON-RPC by POST.", {
      status: 405,
      headers: { ...headers, allow: "POST" },
    });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(failure(null, -32700, "The body is not JSON."), {
      status: 400,
      headers,
    });
  }
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0)
    return Response.json(failure(null, -32600, "Empty batch."), {
      status: 400,
      headers,
    });
  if (messages.length > MAX_BATCH)
    return Response.json(
      failure(null, -32600, `At most ${MAX_BATCH} messages per request.`),
      { status: 400, headers },
    );
  if (overLimit(messages.length))
    return Response.json(failure(null, -32000, "Slow down: rate limited."), {
      status: 429,
      headers: { ...headers, "retry-after": "60" },
    });
  const answers: unknown[] = [];
  for (const message of messages) {
    if (!isRequest(message)) {
      answers.push(failure(null, -32600, "Not a JSON-RPC 2.0 request."));
      continue;
    }
    const answer = await dispatch(message, tools, server);
    if (answer !== undefined) answers.push(answer);
  }
  if (answers.length === 0) return new Response(null, { status: 202, headers });
  return Response.json(Array.isArray(body) ? answers : answers[0], { headers });
}

const EMPTY_ARGUMENTS = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** The three things anyone may ask about one site. */
export function siteTools(
  site: string,
  read: {
    status: () => unknown;
    incidents: () => unknown;
    budget: () => string | null;
  },
): McpTool[] {
  return [
    {
      name: "get_status",
      description: `The current status of ${site}: the headline state, every monitor with its state and 24-hour uptime, the components, open incidents and planned maintenance.`,
      inputSchema: EMPTY_ARGUMENTS,
      run: read.status,
    },
    {
      name: "list_incidents",
      description: `Incidents and maintenance on ${site} from the last 30 days, and anything still open, newest first, with every update.`,
      inputSchema: EMPTY_ARGUMENTS,
      run: read.incidents,
    },
    {
      name: "get_error_budget",
      description: `How ${site} is doing this month against its uptime target, in one sentence. Says so when the site has no target.`,
      inputSchema: EMPTY_ARGUMENTS,
      run: () => read.budget() ?? "This site has no uptime target.",
    },
  ];
}

// ---------------------------------------------------------------------------
// A brake: so many messages a minute per site, counted in memory.

export const MCP_MESSAGES_PER_MINUTE = 120;

const globals = globalThis as {
  __statusMcpCalls?: Map<string, { minute: number; count: number }>;
};

export function mcpOverLimit(
  host: string,
  messages: number,
  now: number,
): boolean {
  globals.__statusMcpCalls ??= new Map();
  const minute = Math.floor(now / 60_000);
  const entry = globals.__statusMcpCalls.get(host);
  const count = (entry?.minute === minute ? entry.count : 0) + messages;
  globals.__statusMcpCalls.set(host, { minute, count });
  return count > MCP_MESSAGES_PER_MINUTE;
}

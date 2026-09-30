import { heartbeatResponse } from "@/lib/site-routes";

export const dynamic = "force-dynamic";

type Context = RouteContext<"/heartbeat/[token]">;

const handle = async (_request: Request, ctx: Context) =>
  heartbeatResponse((await ctx.params).token);

export const GET = handle;
export const POST = handle;
export const HEAD = handle;

import { assetResponse } from "@/lib/site-routes";

export const dynamic = "force-dynamic";

export const GET = (request: Request) => assetResponse("favicon", request);

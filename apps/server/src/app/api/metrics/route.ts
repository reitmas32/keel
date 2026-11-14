import { getContext } from "@/lib/context";
import { handle } from "@/lib/handlers";
import { metricsResponse } from "@/lib/observability";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  return handle(async () => metricsResponse(await getContext(), request));
}

export const GET = withRequestLog(handleGET);

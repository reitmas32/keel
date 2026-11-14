import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  return handlers.ciResult(await getContext(), request);
}

export const POST = withRequestLog(handlePOST);

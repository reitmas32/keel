import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  return handlers.listDokployServices(await getContext(), request);
}

export const GET = withRequestLog(handleGET);

import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handlers.getDeploy(await getContext(), request, (await params).id);
}

export const GET = withRequestLog(handleGET);

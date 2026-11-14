import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ owner: string; name: string; id: string }> },
) {
  const { owner, name, id } = await params;
  return handlers.decideRepoDeploy(await getContext(), request, owner, name, id, "rejected");
}

export const POST = withRequestLog(handlePOST);

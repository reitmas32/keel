import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string }> };

async function handleGET(request: Request, { params }: Params) {
  const { owner, name } = await params;
  return handlers.listScopes(await getContext(), request, owner, name);
}

async function handlePOST(request: Request, { params }: Params) {
  const { owner, name } = await params;
  return handlers.linkScope(await getContext(), request, owner, name);
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);

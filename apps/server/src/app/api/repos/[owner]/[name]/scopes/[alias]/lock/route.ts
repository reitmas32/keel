import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string; alias: string }> };

async function handlePUT(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.lockScope(await getContext(), request, owner, name, alias);
}

async function handleDELETE(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.unlockScope(await getContext(), request, owner, name, alias);
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);

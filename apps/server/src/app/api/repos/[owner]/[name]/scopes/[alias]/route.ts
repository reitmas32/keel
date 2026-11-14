import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string; alias: string }> };

async function handlePATCH(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.updateScope(await getContext(), request, owner, name, alias);
}

export const PATCH = withRequestLog(handlePATCH);

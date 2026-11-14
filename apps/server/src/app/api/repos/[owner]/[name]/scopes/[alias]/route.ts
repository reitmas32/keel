import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string; alias: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.updateScope(await getContext(), request, owner, name, alias);
}

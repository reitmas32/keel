import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string }> };

export async function GET(request: Request, { params }: Params) {
  const { owner, name } = await params;
  return handlers.listScopes(await getContext(), request, owner, name);
}

export async function POST(request: Request, { params }: Params) {
  const { owner, name } = await params;
  return handlers.linkScope(await getContext(), request, owner, name);
}

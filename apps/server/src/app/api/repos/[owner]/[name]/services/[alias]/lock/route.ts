// `…/services/:alias/lock`: the name of `…/scopes/:alias/lock` before v0.7.0, kept for older clients.
import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string; alias: string }> };

export async function PUT(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.lockScope(await getContext(), request, owner, name, alias);
}

export async function DELETE(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.unlockScope(await getContext(), request, owner, name, alias);
}

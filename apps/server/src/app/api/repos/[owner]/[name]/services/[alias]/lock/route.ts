import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; name: string; alias: string }> };

export async function PUT(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.lockService(await getContext(), request, owner, name, alias);
}

export async function DELETE(request: Request, { params }: Params) {
  const { owner, name, alias } = await params;
  return handlers.unlockService(await getContext(), request, owner, name, alias);
}

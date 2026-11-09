// `…/services`: the name of `…/scopes` before v0.7.0, kept for older clients (keel CLI v0.6.0 and earlier).
import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await params;
  return handlers.listScopes(await getContext(), request, owner, name);
}

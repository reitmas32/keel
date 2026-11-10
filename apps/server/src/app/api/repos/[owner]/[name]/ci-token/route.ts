import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await params;
  return handlers.rotateCiToken(await getContext(), request, owner, name);
}

import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; name: string; id: string }> },
) {
  const { owner, name, id } = await params;
  return handlers.getRepoDeploy(getContext(), owner, name, id);
}

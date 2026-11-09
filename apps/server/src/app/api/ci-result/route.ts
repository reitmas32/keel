import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlers.ciResult(await getContext(), request);
}

import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handlers.listDokployServices(await getContext(), request);
}

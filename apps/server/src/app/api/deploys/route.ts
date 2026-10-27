import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handlers.createDeploy(getContext(), request);
}

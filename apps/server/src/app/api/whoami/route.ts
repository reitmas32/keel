import { getContext } from "@/lib/context";
import { handlers } from "@/lib/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handlers.whoami(getContext(), request);
}

import { getContext } from "@/lib/context";
import { healthResponse } from "@/lib/observability";

export const dynamic = "force-dynamic";

export function GET() {
  return healthResponse(getContext);
}

import { getContext } from "@/lib/context";
import { handle } from "@/lib/handlers";
import { metricsResponse } from "@/lib/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => metricsResponse(await getContext(), request));
}

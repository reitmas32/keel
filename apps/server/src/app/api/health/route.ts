import { getContext } from "@/lib/context";
import { healthResponse } from "@/lib/observability";
import { withRequestLog } from "@/lib/request-log";

export const dynamic = "force-dynamic";

// Logged only when it fails (or at debug): probes call it all day.
export const GET = withRequestLog((_request: Request) => healthResponse(getContext));

import type { ReactNode } from "react";
import { AdminShell } from "../ui";

// Admin pages read the session cookie and the DB on every request; never prerender them.
export const dynamic = "force-dynamic";

export default function AuditLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}

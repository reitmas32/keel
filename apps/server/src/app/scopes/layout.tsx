import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "../login/actions";

// Admin pages read the session cookie and the DB on every request; never prerender them.
export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="top">
        <Link href="/scopes" className="brand">
          keel
        </Link>
        <form action={logout}>
          <button type="submit" className="secondary">
            Salir
          </button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}

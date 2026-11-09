import Link from "next/link";
import { getContext } from "@/lib/context";
import { checkInvite } from "@/lib/members";
import { PASSWORD_MIN } from "@/lib/passwords";
import { KeelMark } from "../../icons";
import { AcceptInviteForm } from "./form";

// Reads the invite on every request; never prerender it.
export const dynamic = "force-dynamic";

/** Public: whoever has the link sets the password of the member it was made for. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { store, now } = await getContext();
  const check = await checkInvite(store, token, now());

  return (
    <main className="login">
      <div className="card">
        <div className="card-header">
          <div>
            <span className="brand">
              <span className="brand-mark">
                <KeelMark />
              </span>
            </span>
            <h1 className="card-title">{check.ok ? `Hola, ${check.member.name}` : "Invitación no válida"}</h1>
            <p className="card-description">
              {check.ok ? (
                <>
                  Pon una contraseña para entrar a keel como <strong>{check.member.email}</strong>.
                </>
              ) : (
                check.reason
              )}
            </p>
          </div>
        </div>
        <div className="card-content">
          {check.ok ? (
            <AcceptInviteForm token={token} minLength={PASSWORD_MIN} />
          ) : (
            <Link className="btn btn-outline btn-block" href="/login">
              Ir a entrar
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}

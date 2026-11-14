import { getContext } from "@/lib/context";
import { KeelMark } from "../icons";
import { LoginForm } from "./form";

// Whether Accounts is configured is read at runtime from the environment.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const accounts = (await getContext()).accounts !== null;
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
            <h1 className="card-title">keel admin</h1>
            <p className="card-description">
              {accounts
                ? "Entra con tu cuenta de Foundathyon Accounts: contraseña o un código por correo."
                : "Entra con tu email y contraseña de keel."}
            </p>
          </div>
        </div>
        <div className="card-content">
          <LoginForm accounts={accounts} />
          <p className="hint login-hint">
            Acceso de emergencia: deja el email vacío y usa <code>KEEL_ADMIN_PASSWORD</code>.
          </p>
        </div>
      </div>
    </main>
  );
}

import Link from "next/link";
import { getContext } from "@/lib/context";
import { requireAdmin } from "../session";
import { CreateScopeForm } from "./components";

export default async function ScopesPage() {
  await requireAdmin();
  const { store } = getContext();
  const scopes = store.listScopes().map((scope) => ({ ...scope, services: store.listServices(scope.id).length }));

  return (
    <>
      <h1>Scopes</h1>
      <p className="muted">
        Cada scope vincula un repo de GitHub con los servicios de Dokploy a los que puede desplegar.
      </p>

      <section className="card">
        <h2>Nuevo scope</h2>
        <CreateScopeForm />
      </section>

      <section className="card">
        {scopes.length === 0 ? (
          <p className="muted">Todavía no hay scopes.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Repo</th>
                  <th>Servicios</th>
                </tr>
              </thead>
              <tbody>
                {scopes.map((scope) => (
                  <tr key={scope.id}>
                    <td>
                      <Link href={`/scopes/${scope.id}`}>{scope.name}</Link>
                    </td>
                    <td>
                      <code>{scope.repo}</code>
                    </td>
                    <td>{scope.services}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

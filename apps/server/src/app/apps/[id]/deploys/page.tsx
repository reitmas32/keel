import Link from "next/link";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { Card, deployTone, StatusBadge } from "../../../ui";
import { AppPage, loadApp, none } from "../shared";

const LIMIT = 50;

export default async function DeploysPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { app, appRole } = await loadApp(params);
  const { store } = await getContext();
  const scopes = await store.listScopes(app.id);
  const wanted = (await searchParams).scope;
  const selected = scopes.find((s) => s.alias === wanted);
  const deploys = await store.listDeploys(
    { repo: app.repo, ...(selected && { scopeId: selected.id }) },
    { limit: LIMIT, newestFirst: true },
  );
  const base = `/apps/${app.id}/deploys`;

  return (
    <AppPage app={app} appRole={appRole} section="Deploys">
      {scopes.length > 1 && (
        <nav className="filter-chips" aria-label="Filtrar por scope">
          <Link href={base} className="chip" aria-current={selected ? undefined : "page"}>
            Todos
          </Link>
          {scopes.map((s) => (
            <Link
              key={s.id}
              href={`${base}?scope=${encodeURIComponent(s.alias)}`}
              className="chip"
              aria-current={selected?.id === s.id ? "page" : undefined}
            >
              {s.alias}
            </Link>
          ))}
        </nav>
      )}
      <Card
        title={selected ? `Deploys de ${selected.alias}` : "Deploys"}
        description={`Los ${LIMIT} más recientes${selected ? "" : " de todos los scopes de la app"}.`}
      >
        {deploys.length === 0 ? (
          <p className="empty">Sin deploys todavía.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Versión</th>
                  <th>Scope</th>
                  <th>Estado</th>
                  <th>Pedido por</th>
                  <th>Creado</th>
                </tr>
              </thead>
              <tbody>
                {deploys.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.tag}</code>
                    </td>
                    <td>{d.scope}</td>
                    <td>
                      <StatusBadge tone={deployTone(d.status)}>{d.status}</StatusBadge>
                      {d.error && <div className="sub">{d.error}</div>}
                    </td>
                    <td>{d.requestedBy ?? none}</td>
                    <td className="muted nowrap">{formatDate(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppPage>
  );
}

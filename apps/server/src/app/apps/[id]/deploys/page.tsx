import { isTerminal, roleAtLeast } from "@keel/shared";
import Link from "next/link";
import { roleOn } from "@/lib/access";
import { APPROVER_ROLE } from "@/lib/approvals";
import { getContext } from "@/lib/context";
import { IconExternal, IconRocket } from "../../../icons";
import { Card, DeployBadge, EmptyState, StatusBadge, When } from "../../../ui";
import { ApprovalButtons } from "../../components";
import { AppPage, dokployDeploymentsUrl, loadApp } from "../shared";

const LIMIT = 50;

export default async function DeploysPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { viewer, app, appRole } = await loadApp(params);
  const { store } = await getContext();
  const scopes = await store.listScopes(app.id);
  const wanted = (await searchParams).scope;
  const selected = scopes.find((s) => s.alias === wanted);
  const deploys = await store.listDeploys(
    { repo: app.repo, ...(selected && { scopeId: selected.id }) },
    { limit: LIMIT, newestFirst: true },
  );
  const base = `/apps/${app.id}/deploys`;
  const scopeById = new Map(scopes.map((s) => [s.id, s]));

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
          <EmptyState icon={<IconRocket />} title="Sin deploys todavía">
            Aparecen al pedirlos con <code>keel deploy</code>.
          </EmptyState>
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
                  <th>Dokploy</th>
                </tr>
              </thead>
              <tbody>
                {deploys.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.tag}</code>
                      <div className="sub mono">{d.sha.slice(0, 7)}</div>
                    </td>
                    <td>{d.scope}</td>
                    <td>
                      <DeployBadge status={d.status} />
                      {d.approval?.status === "pending" && !isTerminal(d.status) && (
                        <>
                          {" "}
                          <StatusBadge tone="running">Espera aprobación</StatusBadge>
                          {d.requestedByMemberId !== viewer.member.id &&
                            roleAtLeast(roleOn(viewer, { repo: app.repo, scope: d.scope }), APPROVER_ROLE) && (
                              <div className="sub">
                                <ApprovalButtons appId={app.id} deployId={d.id} label={`${d.tag} → ${d.scope}`} />
                              </div>
                            )}
                        </>
                      )}
                      {d.approval && d.approval.status !== "pending" && (
                        <div className="sub">
                          {d.approval.status === "approved" ? "Aprobado" : "Rechazado"} por {d.approval.by}
                          {d.approval.reason && `: ${d.approval.reason}`}
                        </div>
                      )}
                      {d.forcedBy && (
                        <div className="sub">
                          Forzado en una ventana de congelamiento por {d.forcedBy}: {d.forcedReason}
                        </div>
                      )}
                      {/* A rejection's error repeats the approval line above. */}
                      {d.error && d.approval?.status !== "rejected" && <div className="sub">{d.error}</div>}
                    </td>
                    <td>{d.requestedBy ?? <span className="muted">sin token</span>}</td>
                    <td className="muted nowrap">
                      <When iso={d.createdAt} />
                    </td>
                    <td className="nowrap">
                      {(() => {
                        const scope = scopeById.get(d.scopeId);
                        // Only a deploy keel handed to Dokploy has a deployment there.
                        if (!scope || !d.deployStartedAt) return <span className="muted">—</span>;
                        return (
                          <a
                            className="link external-link"
                            href={dokployDeploymentsUrl(scope.dokployUrl)}
                            target="_blank"
                            rel="noreferrer"
                            title={`Deployments de ${scope.alias} en Dokploy`}
                          >
                            Ver en Dokploy
                            <IconExternal />
                          </a>
                        );
                      })()}
                    </td>
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

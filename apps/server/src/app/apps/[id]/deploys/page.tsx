import { isTerminal, roleAtLeast } from "@keel/shared";
import Link from "next/link";
import { can, roleOn } from "@/lib/access";
import { APPROVER_ROLE } from "@/lib/approvals";
import { getContext } from "@/lib/context";
import { activeFreeze, FORCE_ROLE, LEVEL_LABEL } from "@/lib/freeze";
import { approvalRequired } from "@/lib/store";
import { IconExternal, IconRocket } from "../../../icons";
import { Card, DeployBadge, EmptyState, StatusBadge, VERSION_LABEL, When } from "../../../ui";
import { ApprovalButtons, type DeployableScope, type DeployableVersion, DeployDrawer } from "../../components";
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
  const { store, now } = await getContext();
  const scopes = await store.listScopes(app.id);
  const wanted = (await searchParams).scope;
  const selected = scopes.find((s) => s.alias === wanted);
  const deploys = await store.listDeploys(
    { repo: app.repo, ...(selected && { scopeId: selected.id }) },
    { limit: LIMIT, newestFirst: true },
  );
  const base = `/apps/${app.id}/deploys`;
  const scopeById = new Map(scopes.map((s) => [s.id, s]));

  // What the "Nuevo deploy" drawer offers: the scopes this member can deploy to, with what would stop or slow it.
  const freezes = await store.freezesFor(app.id);
  const deployable: DeployableScope[] = await Promise.all(
    scopes
      .filter((s) => can(viewer, "deployer", { repo: app.repo, scope: s.alias }))
      .map(async (s) => {
        const [running] = await store.listDeploys(
          { scopeId: s.id, status: "deployed" },
          { limit: 1, newestFirst: true },
        );
        const lock = await store.getScopeLock(s.id);
        const freeze = activeFreeze(freezes, { appId: app.id, scope: s.alias }, now());
        return {
          id: s.id,
          alias: s.alias,
          running: running?.tag ?? null,
          needsApproval: approvalRequired(app, s),
          locked: lock?.reason ?? null,
          freeze: freeze
            ? {
                name: freeze.window.name,
                level: LEVEL_LABEL[freeze.level],
                until: freeze.until,
                canForce: can(viewer, FORCE_ROLE[freeze.level], { repo: app.repo, scope: s.alias }),
              }
            : null,
        };
      }),
  );
  const versions: DeployableVersion[] =
    deployable.length > 0
      ? (await store.listVersions(app.repo, { limit: 30 })).map((v) => ({
          tag: v.tag,
          ciLabel: VERSION_LABEL[v.ciStatus],
          usable: v.ciStatus === "success" || v.ciStatus === "pending",
          branch: v.branch,
        }))
      : [];

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
        action={
          deployable.length > 0 && (
            <DeployDrawer appId={app.id} scopes={deployable} versions={versions} defaultScopeId={selected?.id} />
          )
        }
      >
        {deploys.length === 0 ? (
          <EmptyState icon={<IconRocket />} title="Sin deploys todavía">
            Aparecen al pedirlos con <code>keel deploy</code> o con «Nuevo deploy».
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

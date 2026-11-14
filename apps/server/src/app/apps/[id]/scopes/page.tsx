import { roleAtLeast } from "@keel/shared";
import Link from "next/link";
import { roleOn } from "@/lib/access";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconChevronRight, IconExternal, IconLayers, IconSettings, IconUnlock } from "../../../icons";
import { Card, DeployBadge, EmptyState, When } from "../../../ui";
import { ConfirmButton } from "../../../ui-client";
import { unlinkScopeAction, unlockScopeAction } from "../../actions";
import { InlineScopeSetting, LinkScopeDrawer, LockScopeButton } from "../../components";
import { AppPage, loadApp } from "../shared";

export default async function ScopesPage({ params }: { params: Promise<{ id: string }> }) {
  const { viewer, app, appRole, canMaintain } = await loadApp(params);
  const { store } = await getContext();
  // Each scope's role decides changing, locking and unlinking it: a grant like `prod*` can differ from the repo's.
  const scopes = await Promise.all(
    (await store.listScopes(app.id)).map(async (scope) => {
      const [last] = await store.listDeploys({ scopeId: scope.id }, { limit: 1, newestFirst: true });
      const [running] = await store.listDeploys(
        { scopeId: scope.id, status: "deployed" },
        { limit: 1, newestFirst: true },
      );
      return {
        ...scope,
        last,
        running,
        lock: await store.getScopeLock(scope.id),
        canMaintain: roleAtLeast(roleOn(viewer, { repo: app.repo, scope: scope.alias }), "maintainer"),
      };
    }),
  );

  return (
    <AppPage app={app} appRole={appRole} section="Scopes">
      <Card
        title="Scopes"
        description={
          <>
            Cada scope apunta a un servicio de Dokploy; su nombre es lo que eliges en <code>keel deploy -s</code>. Las
            protecciones se cambian en la propia fila y las de un scope con <code>prod</code> en el nombre piden
            confirmación. Aprobación por defecto de la app:{" "}
            <strong>{app.requireApproval ? "obligatoria" : "no"}</strong>.
          </>
        }
        action={canMaintain && <LinkScopeDrawer appId={app.id} />}
      >
        {scopes.length === 0 ? (
          <EmptyState icon={<IconLayers />} title="Sin scopes">
            Vincula uno por cada servicio de Dokploy al que despliega esta app.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table scope-table">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Corriendo</th>
                  <th>Último deploy</th>
                  <th>Health check</th>
                  <th>Rollback</th>
                  <th>Aprobación</th>
                  <th>
                    <span className="sr-only">Detalles</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {scopes.flatMap((scope) => {
                  const toggleId = `scope-detail-${scope.id}`;
                  const common = { appId: app.id, scopeId: scope.id, alias: scope.alias };
                  return [
                    <tr key={scope.id} className="scope-table-row">
                      <td>
                        <strong className="scope-alias">{scope.alias}</strong>
                        <div className="sub">
                          {scope.kind === "compose" ? (
                            <>
                              Compose · <code>{scope.tagVariable}</code>
                            </>
                          ) : (
                            <>
                              Application · <code>:tag</code>
                            </>
                          )}
                        </div>
                      </td>
                      <td>{scope.running ? <code>{scope.running.tag}</code> : <span className="muted">—</span>}</td>
                      <td>
                        {scope.last ? (
                          <div className="scope-last">
                            <DeployBadge status={scope.last.status} />
                            <span className="sub">
                              {scope.last.id !== scope.running?.id && (
                                <>
                                  <code>{scope.last.tag}</code> ·{" "}
                                </>
                              )}
                              <When iso={scope.last.createdAt} />
                            </span>
                          </div>
                        ) : (
                          <span className="muted small">Sin deploys</span>
                        )}
                      </td>
                      <td>
                        {scope.canMaintain ? (
                          <InlineScopeSetting
                            {...common}
                            setting="healthEnabled"
                            value={scope.healthCheck?.enabled ? "1" : "0"}
                            disabledHint={scope.healthCheck?.url ? undefined : "Sin URL"}
                          />
                        ) : (
                          <span className="small">{scope.healthCheck?.enabled ? "Activo" : "—"}</span>
                        )}
                      </td>
                      <td>
                        {scope.canMaintain ? (
                          <InlineScopeSetting
                            {...common}
                            setting="autoRollback"
                            value={scope.autoRollback ? "1" : "0"}
                          />
                        ) : (
                          <span className="small">{scope.autoRollback ? "Activo" : "—"}</span>
                        )}
                      </td>
                      <td>
                        {scope.canMaintain ? (
                          <InlineScopeSetting
                            {...common}
                            setting="requireApproval"
                            value={scope.requireApproval === null ? "" : scope.requireApproval ? "1" : "0"}
                            appRequiresApproval={app.requireApproval}
                          />
                        ) : (
                          <span className="small">
                            {(scope.requireApproval ?? app.requireApproval) ? "Obligatoria" : "No"}
                          </span>
                        )}
                      </td>
                      <td className="scope-expand-cell">
                        {/* A checkbox, not state: the detail row opens with CSS and needs no client code. */}
                        <input id={toggleId} type="checkbox" className="scope-expand" />
                        <label htmlFor={toggleId} className="btn btn-ghost btn-sm scope-expand-label">
                          <IconChevronRight />
                          <span className="sr-only">Detalles de {scope.alias}</span>
                        </label>
                      </td>
                    </tr>,
                    <tr key={`${scope.id}-detail`} className="scope-detail">
                      <td colSpan={7}>
                        <div className="scope-detail-grid">
                          <dl className="scope-facts">
                            <dt>Dokploy</dt>
                            <dd>
                              <a href={scope.dokployUrl} target="_blank" rel="noreferrer" className="link">
                                {scope.kind === "compose" ? "Compose" : "Application"} <code>{scope.dokployId}</code>{" "}
                                <IconExternal />
                              </a>
                            </dd>
                            <dt>Despliega con</dt>
                            <dd>
                              {scope.kind === "compose" ? (
                                <code>{scope.tagVariable}=&lt;versión&gt;</code>
                              ) : (
                                <>
                                  imagen <code>:&lt;versión&gt;</code>
                                </>
                              )}
                            </dd>
                            <dt>Health check</dt>
                            <dd>
                              {scope.healthCheck?.url ? (
                                <>
                                  <code>{scope.healthCheck.url}</code> · {scope.healthCheck.expectedStatus ?? "2xx"} ·{" "}
                                  {scope.healthCheck.retries}×{scope.healthCheck.intervalSeconds} s · timeout{" "}
                                  {scope.healthCheck.timeoutSeconds} s
                                </>
                              ) : (
                                <span className="muted">Sin configurar</span>
                              )}
                            </dd>
                            <dt>Bloqueo</dt>
                            <dd>
                              {scope.lock ? (
                                <>
                                  {scope.lock.reason}{" "}
                                  <span className="muted">
                                    · por {scope.lock.lockedBy ?? "alguien"}, {formatDate(scope.lock.createdAt)}
                                  </span>
                                </>
                              ) : (
                                <span className="muted">Desbloqueado</span>
                              )}
                            </dd>
                          </dl>
                          {scope.canMaintain && (
                            <div className="scope-detail-actions">
                              <Link href={`/apps/${app.id}/scopes/${scope.id}`} className="btn btn-outline btn-sm">
                                <IconSettings />
                                Editar health check
                              </Link>
                              {scope.lock ? (
                                <form action={unlockScopeAction}>
                                  <input type="hidden" name="appId" value={app.id} />
                                  <input type="hidden" name="scopeId" value={scope.id} />
                                  <button type="submit" className="btn btn-outline btn-sm">
                                    <IconUnlock />
                                    Desbloquear
                                  </button>
                                </form>
                              ) : (
                                <LockScopeButton appId={app.id} scopeId={scope.id} alias={scope.alias} />
                              )}
                              <form action={unlinkScopeAction}>
                                <input type="hidden" name="appId" value={app.id} />
                                <input type="hidden" name="scopeId" value={scope.id} />
                                <ConfirmButton
                                  message={`¿Desvincular el scope ${scope.alias}? Sus deploys y su bloqueo se borran; el servicio de Dokploy no se toca.`}
                                >
                                  Desvincular
                                </ConfirmButton>
                              </form>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppPage>
  );
}

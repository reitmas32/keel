import { roleAtLeast } from "@keel/shared";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { roleOn } from "@/lib/access";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconExternal, IconLock, IconShield, IconTrash, IconUnlock } from "../../icons";
import { requireMember } from "../../session";
import { Card, deployTone, Page, PageHeader, RoleBadge, StatusBadge, versionTone } from "../../ui";
import { ConfirmButton } from "../../ui-client";
import { deleteAppAction, unlinkScopeAction, unlockScopeAction } from "../actions";
import { AddScopeForm, LockScopeButton, RotateTokenForm } from "../components";

const none = <span className="muted">—</span>;

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireMember();
  const { store } = await getContext();
  const app = await store.getApp((await params).id);
  if (!app) notFound();

  // What the member can do here: the app's role decides linking, the CI token and deleting; each scope's role
  // decides locking and unlinking it (a grant like `prod*` can differ from the rest of the repo).
  const appRole = roleOn(viewer, { repo: app.repo });
  const canMaintain = roleAtLeast(appRole, "maintainer");
  const canDelete = roleAtLeast(appRole, "admin");
  const scopes = await Promise.all(
    (await store.listScopes(app.id)).map(async (scope) => ({
      ...scope,
      lock: await store.getScopeLock(scope.id),
      canMaintain: roleAtLeast(roleOn(viewer, { repo: app.repo, scope: scope.alias }), "maintainer"),
    })),
  );
  const deploys = await store.listDeploys({ repo: app.repo }, { limit: 20, newestFirst: true });
  const versions = await store.listVersions(app.repo, { limit: 20 });
  const h = await headers();
  const apiUrl = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}/api`;

  return (
    <Page crumbs={[{ label: "Apps", href: "/apps" }, { label: app.name }]}>
      <PageHeader
        title={app.name}
        description={
          <a className="link" href={`https://github.com/${app.repo}`} target="_blank" rel="noreferrer">
            github.com/{app.repo}
          </a>
        }
        actions={
          <span className="role-hint" title="Tu rol efectivo en esta app, con tus permisos por repo">
            <IconShield />
            Tu rol aquí <RoleBadge role={appRole} />
          </span>
        }
      />

      <div className="stack">
        <Card
          title="Scopes"
          description={
            <>
              Cada scope apunta a un servicio de Dokploy. Su nombre es lo que eliges en <code>keel deploy -s</code>. Un
              scope bloqueado rechaza los deploys nuevos.
            </>
          }
          footer={
            canMaintain && (
              <div className="stack" style={{ gap: "0.75rem" }}>
                <AddScopeForm appId={app.id} />
                <p className="hint">
                  Copia la URL del servicio desde el dashboard de Dokploy. En un <strong>Application</strong> keel
                  cambia el tag de su imagen Docker. En un <strong>Compose</strong> cambia la variable del tag (por
                  defecto <code>DOCKER_TAG</code>) en su Environment y lo redespliega: la imagen debe usarla, p.ej.{" "}
                  <code>
                    image: ${"{DOCKER_IMAGE}"}:${"{DOCKER_TAG}"}
                  </code>
                  .
                </p>
              </div>
            )
          }
        >
          {scopes.length === 0 ? (
            <p className="empty">
              Todavía no hay scopes. Agrega uno por cada servicio de Dokploy al que despliega esta app.
            </p>
          ) : (
            <ul className="scope-list">
              {scopes.map((scope) => (
                <li key={scope.id} className="scope-row">
                  <div className="scope-main">
                    <div className="scope-title">
                      <a href={scope.dokployUrl} target="_blank" rel="noreferrer">
                        {scope.alias}
                        <IconExternal />
                      </a>
                      <span className="badge badge-outline">
                        {scope.kind === "compose" ? "Compose" : "Application"}
                      </span>
                    </div>
                    <span className="muted small">
                      <code>{scope.dokployId}</code> ·{" "}
                      {scope.kind === "compose" ? (
                        <code>{scope.tagVariable}=&lt;versión&gt;</code>
                      ) : (
                        <>
                          imagen <code>:&lt;versión&gt;</code>
                        </>
                      )}
                    </span>
                  </div>

                  <div className="scope-lock">
                    {scope.lock ? (
                      <>
                        <span>
                          <StatusBadge tone="running">
                            <IconLock />
                            Bloqueado
                          </StatusBadge>
                        </span>
                        <span className="small">{scope.lock.reason}</span>
                        <span className="muted small">
                          por {scope.lock.lockedBy ?? "alguien"}, {formatDate(scope.lock.createdAt)}
                        </span>
                      </>
                    ) : (
                      <span>
                        <StatusBadge tone="idle">Desbloqueado</StatusBadge>
                      </span>
                    )}
                  </div>

                  {scope.canMaintain && (
                    <div className="scope-actions">
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
                          variant="outline"
                          message={`¿Desvincular el scope ${scope.alias}? Sus deploys y su bloqueo se borran; el servicio de Dokploy no se toca.`}
                        >
                          Desvincular
                        </ConfirmButton>
                      </form>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="GitHub Action"
          description={
            <>
              El último paso del workflow debe llamar a <code>{apiUrl}/ci-result</code> con el header{" "}
              <code>Authorization: Bearer $DEPLOY_API_TOKEN</code>.
            </>
          }
        >
          {canMaintain ? (
            <RotateTokenForm appId={app.id} />
          ) : (
            <p className="hint">Solo un maintainer de esta app puede generar un nuevo token de CI.</p>
          )}
        </Card>

        <Card title="Versiones" description="Las 20 más recientes, de keel create-version o de su CI.">
          {versions.length === 0 ? (
            <p className="empty">
              Sin versiones todavía. Aparecen al crearlas con <code>keel create-version</code> o cuando su CI avisa.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Versión</th>
                    <th>Rama</th>
                    <th>Creada por</th>
                    <th>CI</th>
                    <th>Creada</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.tag}>
                      <td>
                        <code>{v.tag}</code>
                      </td>
                      <td>{v.branch ? <code>{v.branch}</code> : none}</td>
                      <td>{v.createdByName ?? v.createdByEmail ?? none}</td>
                      <td>
                        <StatusBadge tone={versionTone(v.ciStatus)} href={v.runUrl}>
                          {v.ciStatus}
                        </StatusBadge>
                      </td>
                      <td className="muted nowrap">{formatDate(v.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Deploys recientes" description="Los 20 más recientes de todos los scopes de la app.">
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

        {canDelete && (
          <Card
            className="card-danger"
            title="Zona peligrosa"
            description="Elimina la app, sus scopes y su historial de deploys. Los servicios de Dokploy no se tocan. No se puede deshacer."
            action={
              <form action={deleteAppAction}>
                <input type="hidden" name="appId" value={app.id} />
                <ConfirmButton message={`¿Eliminar la app ${app.repo}, sus scopes y su historial de deploys?`}>
                  <IconTrash />
                  Eliminar app
                </ConfirmButton>
              </form>
            }
          />
        )}
      </div>
    </Page>
  );
}

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconExternal, IconLock, IconTrash, IconUnlock } from "../../icons";
import { requireAdmin } from "../../session";
import { Card, deployTone, Page, PageHeader, StatusBadge, versionTone } from "../../ui";
import { ConfirmButton } from "../../ui-client";
import { deleteScopeAction, deleteServiceAction, unlockServiceAction } from "../actions";
import { AddServiceForm, LockServiceButton, RotateTokenForm } from "../components";

const none = <span className="muted">—</span>;

export default async function ScopePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { store } = await getContext();
  const scope = await store.getScope((await params).id);
  if (!scope) notFound();

  const services = await Promise.all(
    (await store.listServices(scope.id)).map(async (service) => ({
      ...service,
      lock: await store.getServiceLock(service.id),
    })),
  );
  const deploys = await store.listDeploys({ repo: scope.repo }, { limit: 20, newestFirst: true });
  const versions = await store.listVersions(scope.repo, { limit: 20 });
  const h = await headers();
  const apiUrl = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}/api`;

  return (
    <Page crumbs={[{ label: "Scopes", href: "/scopes" }, { label: scope.name }]}>
      <PageHeader
        title={scope.name}
        description={
          <a className="link" href={`https://github.com/${scope.repo}`} target="_blank" rel="noreferrer">
            github.com/{scope.repo}
          </a>
        }
      />

      <div className="stack">
        <Card
          title="Servicios de Dokploy"
          description={
            <>
              El alias es lo que eliges en <code>keel deploy -s</code>. Un servicio bloqueado rechaza los deploys
              nuevos.
            </>
          }
          footer={
            <div className="stack" style={{ gap: "0.75rem" }}>
              <AddServiceForm scopeId={scope.id} />
              <p className="hint">
                Copia la URL del servicio desde el dashboard de Dokploy. En un <strong>Application</strong> keel cambia
                el tag de su imagen Docker. En un <strong>Compose</strong> cambia la variable del tag (por defecto{" "}
                <code>DOCKER_TAG</code>) en su Environment y lo redespliega: la imagen debe usarla, p.ej.{" "}
                <code>
                  image: ${"{DOCKER_IMAGE}"}:${"{DOCKER_TAG}"}
                </code>
                .
              </p>
            </div>
          }
        >
          {services.length === 0 ? (
            <p className="empty">Todavía no hay servicios vinculados.</p>
          ) : (
            <ul className="service-list">
              {services.map((service) => (
                <li key={service.id} className="service-row">
                  <div className="service-main">
                    <div className="service-title">
                      <a href={service.dokployUrl} target="_blank" rel="noreferrer">
                        {service.alias}
                        <IconExternal />
                      </a>
                      <span className="badge badge-outline">
                        {service.kind === "compose" ? "Compose" : "Application"}
                      </span>
                    </div>
                    <span className="muted small">
                      <code>{service.dokployId}</code> ·{" "}
                      {service.kind === "compose" ? (
                        <code>{service.tagVariable}=&lt;versión&gt;</code>
                      ) : (
                        <>
                          imagen <code>:&lt;versión&gt;</code>
                        </>
                      )}
                    </span>
                  </div>

                  <div className="service-lock">
                    {service.lock ? (
                      <>
                        <span>
                          <StatusBadge tone="running">
                            <IconLock />
                            Bloqueado
                          </StatusBadge>
                        </span>
                        <span className="small">{service.lock.reason}</span>
                        <span className="muted small">
                          por {service.lock.lockedBy ?? "alguien"}, {formatDate(service.lock.createdAt)}
                        </span>
                      </>
                    ) : (
                      <span>
                        <StatusBadge tone="idle">Desbloqueado</StatusBadge>
                      </span>
                    )}
                  </div>

                  <div className="service-actions">
                    {service.lock ? (
                      <form action={unlockServiceAction}>
                        <input type="hidden" name="scopeId" value={scope.id} />
                        <input type="hidden" name="serviceId" value={service.id} />
                        <button type="submit" className="btn btn-outline btn-sm">
                          <IconUnlock />
                          Desbloquear
                        </button>
                      </form>
                    ) : (
                      <LockServiceButton scopeId={scope.id} serviceId={service.id} alias={service.alias} />
                    )}
                    <form action={deleteServiceAction}>
                      <input type="hidden" name="scopeId" value={scope.id} />
                      <input type="hidden" name="serviceId" value={service.id} />
                      <ConfirmButton variant="outline" message={`¿Desvincular ${service.alias}?`}>
                        Desvincular
                      </ConfirmButton>
                    </form>
                  </div>
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
          <RotateTokenForm scopeId={scope.id} />
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

        <Card title="Deploys recientes" description="Los 20 más recientes de todos los servicios del scope.">
          {deploys.length === 0 ? (
            <p className="empty">Sin deploys todavía.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Versión</th>
                    <th>Servicio</th>
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
                      <td>{d.service}</td>
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

        <Card
          className="card-danger"
          title="Zona peligrosa"
          description="Elimina el scope, sus servicios vinculados y su historial de deploys. No se puede deshacer."
          action={
            <form action={deleteScopeAction}>
              <input type="hidden" name="scopeId" value={scope.id} />
              <ConfirmButton message={`¿Eliminar el scope ${scope.repo}, sus servicios y su historial de deploys?`}>
                <IconTrash />
                Eliminar scope
              </ConfirmButton>
            </form>
          }
        />
      </div>
    </Page>
  );
}

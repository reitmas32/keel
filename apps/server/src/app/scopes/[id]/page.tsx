import type { DeployStatus } from "@keel/shared";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContext } from "@/lib/context";
import { requireAdmin } from "../../session";
import { deleteScopeAction, deleteServiceAction } from "../actions";
import { AddServiceForm, ConfirmButton, RotateTokenForm } from "../components";

const BADGE: Record<DeployStatus, string> = {
  waiting_ci: "",
  ci_passed: "warn",
  deploying: "warn",
  deployed: "ok",
  ci_failed: "err",
  deploy_failed: "err",
  expired: "err",
};

const formatDate = (iso: string) =>
  `${new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })} UTC`;

export default async function ScopePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { store } = getContext();
  const scope = store.getScope((await params).id);
  if (!scope) notFound();

  const services = store.listServices(scope.id);
  const deploys = store.listDeploys({ repo: scope.repo }, { limit: 20, newestFirst: true });
  const h = await headers();
  const apiUrl = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}/api`;

  return (
    <>
      <p>
        <Link href="/scopes">← Scopes</Link>
      </p>
      <h1>{scope.name}</h1>
      <p className="muted">
        <a href={`https://github.com/${scope.repo}`} target="_blank" rel="noreferrer">
          github.com/{scope.repo}
        </a>
      </p>

      <section className="card">
        <h2>Servicios de Dokploy</h2>
        {services.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Tipo</th>
                  <th>ID en Dokploy</th>
                  <th>Cómo despliega</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td>
                      <a href={service.dokployUrl} target="_blank" rel="noreferrer">
                        {service.alias}
                      </a>
                    </td>
                    <td>{service.kind === "compose" ? "Compose" : "Application"}</td>
                    <td>
                      <code>{service.dokployId}</code>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {service.kind === "compose" ? (
                        <code>{service.tagVariable}=&lt;versión&gt;</code>
                      ) : (
                        <>
                          imagen <code>:&lt;versión&gt;</code>
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <form action={deleteServiceAction}>
                        <input type="hidden" name="scopeId" value={scope.id} />
                        <input type="hidden" name="serviceId" value={service.id} />
                        <ConfirmButton message={`¿Desvincular ${service.alias}?`}>Desvincular</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AddServiceForm scopeId={scope.id} />
        <p className="muted" style={{ fontSize: 13 }}>
          El alias es lo que eliges en <code>keel deploy</code>. Copia la URL del servicio desde el dashboard de
          Dokploy. En un <strong>Application</strong> keel cambia el tag de su imagen Docker. En un{" "}
          <strong>Compose</strong> cambia la variable del tag (por defecto <code>DOCKER_TAG</code>) en su Environment y
          lo redespliega: la imagen debe usarla, p.ej.{" "}
          <code>
            image: ${"{DOCKER_IMAGE}"}:${"{DOCKER_TAG}"}
          </code>
          .
        </p>
      </section>

      <section className="card">
        <h2>GitHub Action</h2>
        <p>
          El último paso del workflow debe llamar a <code>{apiUrl}/ci-result</code> con el header{" "}
          <code>Authorization: Bearer $DEPLOY_API_TOKEN</code>.
        </p>
        <RotateTokenForm scopeId={scope.id} />
      </section>

      <section className="card">
        <h2>Deploys recientes</h2>
        {deploys.length === 0 ? (
          <p className="muted">Sin deploys todavía.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Versión</th>
                  <th>Servicio</th>
                  <th>Estado</th>
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
                      <span className={`badge ${BADGE[d.status]}`}>{d.status}</span>
                      {d.error && (
                        <div className="muted" style={{ fontSize: 13 }}>
                          {d.error}
                        </div>
                      )}
                    </td>
                    <td className="muted">{formatDate(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Zona peligrosa</h2>
        <form action={deleteScopeAction}>
          <input type="hidden" name="scopeId" value={scope.id} />
          <ConfirmButton message={`¿Eliminar el scope ${scope.repo}, sus servicios y su historial de deploys?`}>
            Eliminar scope
          </ConfirmButton>
        </form>
      </section>
    </>
  );
}

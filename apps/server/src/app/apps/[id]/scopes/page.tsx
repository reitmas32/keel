import { roleAtLeast } from "@keel/shared";
import { roleOn } from "@/lib/access";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconExternal, IconLock, IconUnlock } from "../../../icons";
import { Card, StatusBadge } from "../../../ui";
import { ConfirmButton } from "../../../ui-client";
import { unlinkScopeAction, unlockScopeAction } from "../../actions";
import { AddScopeForm, LockScopeButton } from "../../components";
import { AppPage, loadApp } from "../shared";

export default async function ScopesPage({ params }: { params: Promise<{ id: string }> }) {
  const { viewer, app, appRole, canMaintain } = await loadApp(params);
  const { store } = await getContext();
  // Each scope's role decides locking and unlinking it: a grant like `prod*` can differ from the rest of the repo.
  const scopes = await Promise.all(
    (await store.listScopes(app.id)).map(async (scope) => ({
      ...scope,
      lock: await store.getScopeLock(scope.id),
      canMaintain: roleAtLeast(roleOn(viewer, { repo: app.repo, scope: scope.alias }), "maintainer"),
    })),
  );

  return (
    <AppPage app={app} appRole={appRole} section="Scopes">
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
                Copia la URL del servicio desde el dashboard de Dokploy. En un <strong>Application</strong> keel cambia
                el tag de su imagen Docker. En un <strong>Compose</strong> cambia la variable del tag (por defecto{" "}
                <code>DOCKER_TAG</code>) en su Environment y lo redespliega: la imagen debe usarla, p.ej.{" "}
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
                    <span className="badge badge-outline">{scope.kind === "compose" ? "Compose" : "Application"}</span>
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
    </AppPage>
  );
}

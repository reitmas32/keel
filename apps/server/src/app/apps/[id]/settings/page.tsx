import { roleAtLeast } from "@keel/shared";
import { headers } from "next/headers";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { CreateFreezeForm } from "../../../freezes/components";
import { FreezeList } from "../../../freezes/list";
import { IconTrash } from "../../../icons";
import { Card } from "../../../ui";
import { ConfirmButton } from "../../../ui-client";
import { deleteAppAction } from "../../actions";
import { AppApprovalForm, RotateTokenForm } from "../../components";
import { AppPage, loadApp } from "../shared";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { app, appRole, canMaintain } = await loadApp(params);
  const { store, env, now } = await getContext();
  const [appFreezes, orgFreezes] = await Promise.all([
    store.listFreezes({ appId: app.id }),
    store.listFreezes({ appId: null }),
  ]);
  const canDelete = roleAtLeast(appRole, "admin");
  const h = await headers();
  const apiUrl = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}/api`;

  return (
    <AppPage app={app} appRole={appRole} section="Configuración">
      <Card title="App" description="Lo que keel sabe de esta app.">
        <dl className="meta-list">
          <dt>Nombre</dt>
          <dd>{app.name}</dd>
          <dt>Repo</dt>
          <dd>
            <code>{app.repo}</code>
          </dd>
          <dt>API de keel</dt>
          <dd>
            <code>{apiUrl}</code>
          </dd>
          <dt>Creada</dt>
          <dd>{formatDate(app.createdAt)}</dd>
        </dl>
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
      <Card
        title="Aprobaciones"
        description="Con esto activo, cada deploy espera a que otro miembro con rol maintainer lo apruebe (en Deploys o con keel approve). Cada scope puede cambiarlo en su configuración."
      >
        {canDelete ? (
          <AppApprovalForm key={String(app.requireApproval)} appId={app.id} requireApproval={app.requireApproval} />
        ) : (
          <p className="hint">
            {app.requireApproval ? "Activadas" : "Desactivadas"}. Solo un admin de esta app puede cambiarlo.
          </p>
        )}
      </Card>
      <Card
        title="Ventanas de congelamiento"
        description="Mientras una está activa keel rechaza los deploys nuevos de esta app y retiene los que estaban en cola. Un maintainer puede forzarlas con keel deploy --force-freeze."
        footer={canMaintain && <CreateFreezeForm appId={app.id} timezone={env.KEEL_TIMEZONE ?? "UTC"} />}
      >
        <FreezeList windows={appFreezes} now={now()} canEdit={canMaintain} />
        {orgFreezes.length > 0 && (
          <>
            <p className="hint">
              Además aplican las de la organización, que pesan más (solo un admin puede forzarlas):
            </p>
            <FreezeList windows={orgFreezes} now={now()} canEdit={false} />
          </>
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
    </AppPage>
  );
}

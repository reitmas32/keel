import { roleAtLeast } from "@keel/shared";
import { notFound } from "next/navigation";
import { roleOn } from "@/lib/access";
import { getContext } from "@/lib/context";
import { Card } from "../../../../ui";
import { ScopeSettingsForm } from "../../../components";
import { AppPage, loadApp } from "../../shared";

export default async function ScopeSettingsPage({ params }: { params: Promise<{ id: string; scopeId: string }> }) {
  const { viewer, app, appRole } = await loadApp(params);
  const { store } = await getContext();
  const scope = await store.getScope((await params).scopeId);
  if (scope?.appId !== app.id) notFound();
  const canMaintain = roleAtLeast(roleOn(viewer, { repo: app.repo, scope: scope.alias }), "maintainer");

  return (
    <AppPage app={app} appRole={appRole} section={`Scope ${scope.alias}`}>
      <Card
        title="Después del deploy"
        description={
          <>
            Sin health check, un deploy queda <code>deployed</code> cuando Dokploy termina. Con él, keel además llama a
            la URL: si no responde bien tras los intentos, el deploy queda <code>deploy_failed</code>. El rollback
            automático vuelve a la última versión que keel desplegó bien en este scope, sin pasar por bloqueos, ventanas
            de congelamiento ni aprobaciones.
          </>
        }
      >
        {canMaintain ? (
          <ScopeSettingsForm
            appId={app.id}
            scopeId={scope.id}
            healthCheck={scope.healthCheck}
            autoRollback={scope.autoRollback}
            requireApproval={scope.requireApproval}
            appRequiresApproval={app.requireApproval}
          />
        ) : (
          <p className="hint">Solo un maintainer de este scope puede cambiar su configuración.</p>
        )}
      </Card>
    </AppPage>
  );
}

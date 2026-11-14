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
        description="Qué hace keel cuando Dokploy termina, si un deploy falla y quién tiene que aprobarlo. Todo empieza apagado."
      >
        {canMaintain ? (
          <ScopeSettingsForm
            // React resets a submitted form to its first defaults; a new key mounts it with the saved values.
            key={JSON.stringify([scope.healthCheck, scope.autoRollback, scope.requireApproval, app.requireApproval])}
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

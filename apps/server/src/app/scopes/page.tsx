import Link from "next/link";
import { getContext } from "@/lib/context";
import { IconLock, IconRepo, IconServer } from "../icons";
import { requireAdmin } from "../session";
import { deployTone, Page, PageHeader, StatusBadge } from "../ui";
import { CreateScopeForm } from "./components";

export default async function ScopesPage() {
  await requireAdmin();
  const { store } = await getContext();
  const scopes = await Promise.all(
    (await store.listScopes()).map(async (scope) => {
      const services = await store.listServices(scope.id);
      const [last] = await store.listDeploys({ repo: scope.repo }, { limit: 1, newestFirst: true });
      const locks = await Promise.all(services.map((s) => store.getServiceLock(s.id)));
      return {
        ...scope,
        services: services.length,
        locked: locks.filter(Boolean).length,
        last,
      };
    }),
  );

  return (
    <Page crumbs={[{ label: "Scopes" }]}>
      <PageHeader
        title="Scopes"
        description="Cada scope vincula un repo de GitHub con los servicios de Dokploy a los que puede desplegar."
      />

      <div className="card-grid">
        {scopes.map((scope) => (
          <Link key={scope.id} href={`/scopes/${scope.id}`} className="card scope-card">
            <div className="scope-card-head">
              <div className="stack" style={{ gap: "0.25rem", minWidth: 0 }}>
                <h2 className="card-title">{scope.name}</h2>
                <span className="muted small" style={{ overflowWrap: "anywhere" }}>
                  {scope.repo}
                </span>
              </div>
              <span className="tile-icon">
                <IconRepo />
              </span>
            </div>
            <div className="scope-card-meta">
              <span className="meta-item">
                <IconServer />
                {scope.services === 1 ? "1 servicio" : `${scope.services} servicios`}
              </span>
              {scope.locked > 0 && (
                <span className="meta-item">
                  <IconLock />
                  {scope.locked === 1 ? "1 bloqueado" : `${scope.locked} bloqueados`}
                </span>
              )}
              {scope.last ? (
                <StatusBadge tone={deployTone(scope.last.status)}>
                  {scope.last.tag} · {scope.last.status}
                </StatusBadge>
              ) : (
                <StatusBadge tone="idle">sin deploys</StatusBadge>
              )}
            </div>
          </Link>
        ))}

        <section className="card new-card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Nuevo scope</h2>
              <p className="card-description">Pega la URL del repo. Te damos el token para su GitHub Action.</p>
            </div>
          </div>
          <div className="card-content">
            <CreateScopeForm />
          </div>
        </section>
      </div>
    </Page>
  );
}
